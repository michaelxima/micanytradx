// tradeController.js
// Human-in-the-loop trade actions. Phase B: orders now route through the
// hardened exchangeManager (rate limiting, polling, partial fills, fee
// capture, error translation). Position size is owned by the risk manager.
// The live engine's in-memory state is still synced after each DB commit so
// the WebSocket monitor and the database never drift apart.
require('dotenv').config();
const pool = require('./db');
const { performRiskCheck } = require('./riskManager');
const { placeOrderAndWaitForFill } = require('./exchangeManager');
const engine = require('./strategyEngine');
const { notifyTradeExecuted, notifyTradeClosed } = require('./notificationManager');

// ---------------------------------------------------------------------------
// confirmBuy
// Risk-checks, sizes the position, places a LIMIT BUY through the hardened
// manager, records the real fill (qty, avg price, commission) and opens a
// trade row, then flips the live engine into "in position".
//
// Signature note (Phase B): quantity is now derived by the risk manager, so
// it is NO LONGER a parameter. server.js calls confirmBuy(signalId, userId,
// confirmedPrice).
// ---------------------------------------------------------------------------
async function confirmBuy(signalId, userId = 'in-house-user', confirmedPrice) {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        // 1. Fetch the pending signal (locked for the duration of the txn).
        const signalRes = await dbClient.query(
            `SELECT * FROM signals WHERE id = $1 AND status = 'pending_review' FOR UPDATE`,
            [signalId]
        );
        if (signalRes.rows.length === 0) {
            throw new Error('Signal not found or already processed.');
        }
        const signal = signalRes.rows[0];

        // 2. RISK CHECK — this also sizes the position.
        const entryPrice = confirmedPrice !== null && confirmedPrice !== undefined
            ? parseFloat(confirmedPrice)
            : parseFloat(signal.suggested_price);
        const stopLossPrice = entryPrice * 0.975; // 2.5% stop

        const riskCheck = await performRiskCheck(entryPrice, stopLossPrice);
        if (!riskCheck.canTrade) {
            throw new Error(`Trade blocked: ${riskCheck.reasons.join(', ')}`);
        }
        const { quantity } = riskCheck.positionSizing;

        // 3. EXECUTE via the hardened manager (LIMIT GTC).
        console.log(
            `\ud83d\ude80 Executing BUY via hardened manager: ${signal.symbol} | Qty: ${quantity}`
        );
        const orderResult = await placeOrderAndWaitForFill({
            symbol: signal.symbol.toUpperCase(),
            side: 'BUY',
            quantity: quantity.toString(),
            type: 'LIMIT',
            price: entryPrice.toString(),
            timeInForce: 'GTC',
        });

        // 4. Record only what ACTUALLY filled (handles partial fills).
        const actualQty = orderResult.filledQty;
        const actualEntryPrice = orderResult.avgPrice;
        const commission = orderResult.commission;

        if (!(actualQty > 0)) {
            throw new Error('Order produced no fills; nothing to record.');
        }

        // 5. Mark signal executed and open the trade row.
        await dbClient.query(
            `UPDATE signals SET status = 'executed', reviewed_at = NOW() WHERE id = $1`,
            [signalId]
        );

        const tradeRes = await dbClient.query(
            `INSERT INTO trades (
                signal_id, symbol, side, entry_price, quantity,
                exchange_order_id, stop_loss_price, commission, commission_asset,
                status, opened_at
             ) VALUES ($1, $2, 'LONG', $3, $4, $5, $6, $7, $8, 'OPEN', NOW())
             RETURNING id`,
            [
                signalId,
                signal.symbol.toUpperCase(),
                actualEntryPrice,
                actualQty,
                orderResult.orderId.toString(),
                stopLossPrice,
                commission,
                orderResult.commissionAsset,
            ]
        );

        await dbClient.query('COMMIT');

        // 6. ONLY after the DB commit, drive the live engine state.
        engine.confirmBuy(actualEntryPrice);

        // Phase G: alert that a trade was executed.
        notifyTradeExecuted(signal.symbol.toUpperCase(), 'LONG', actualQty, actualEntryPrice.toFixed(2));

        return {
            success: true,
            tradeId: tradeRes.rows[0].id,
            exchangeOrderId: orderResult.orderId,
            entryPrice: actualEntryPrice,
            quantity: actualQty,
            stopLossPrice,
            commission,
            commissionAsset: orderResult.commissionAsset,
            status: orderResult.status,
            message: `Trade executed. Status: ${orderResult.status}`,
        };
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('\u274c Error during confirmBuy:', error.message);
        throw new Error(`Failed to execute trade: ${error.message}`);
    } finally {
        dbClient.release();
    }
}

// ---------------------------------------------------------------------------
// confirmSell
// Places a MARKET SELL through the hardened manager, computes NET P&L
// (gross minus both buy and sell commissions), records the exit, and flips
// the engine back to flat.
// ---------------------------------------------------------------------------
async function confirmSell(tradeId, exitPrice = null, reason = 'manual') {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        // 1. Fetch the open trade (locked).
        const tradeRes = await dbClient.query(
            `SELECT * FROM trades WHERE id = $1 AND status = 'OPEN' FOR UPDATE`,
            [tradeId]
        );
        if (tradeRes.rows.length === 0) {
            throw new Error('Open trade not found or already closed.');
        }
        const trade = tradeRes.rows[0];

        // 2. EXECUTE MARKET SELL via the hardened manager (immediate exit).
        console.log(`\ud83d\ude80 Executing SELL via hardened manager: ${trade.symbol}`);
        const orderResult = await placeOrderAndWaitForFill({
            symbol: trade.symbol.toUpperCase(),
            side: 'SELL',
            quantity: parseFloat(trade.quantity).toString(),
            type: 'MARKET',
        });

        // 3. Fill details. Fall back to provided exitPrice / live price if the
        //    exchange gave us nothing usable.
        let actualExitPrice = orderResult.avgPrice;
        if (!(actualExitPrice > 0)) {
            actualExitPrice = exitPrice !== null
                ? parseFloat(exitPrice)
                : engine.getState().currentPrice;
        }
        const sellCommission = orderResult.commission;

        // 4. NET P&L (gross minus buy + sell fees).
        const entry = parseFloat(trade.entry_price);
        const qty = parseFloat(trade.quantity);
        const buyCommission = parseFloat(trade.commission || 0);

        const grossPnl = (actualExitPrice - entry) * qty;
        // NOTE: if a commission was paid in BNB rather than USDT, exact math
        // would require converting it to USDT. We accept a tiny margin here.
        const netPnlAbsolute = grossPnl - buyCommission - sellCommission;
        const netPnlPercentage = (netPnlAbsolute / (entry * qty)) * 100;

        // 5. Close the trade; accumulate total commission (buy + sell).
        await dbClient.query(
            `UPDATE trades SET
                status = 'CLOSED',
                exit_price = $1,
                pnl_absolute = $2,
                pnl_percentage = $3,
                commission = commission + $4,
                closed_at = NOW()
             WHERE id = $5`,
            [
                actualExitPrice,
                netPnlAbsolute.toFixed(8),
                netPnlPercentage.toFixed(4),
                sellCommission,
                tradeId,
            ]
        );

        await dbClient.query('COMMIT');

        // 6. Drive the engine back to flat only after the DB commit.
        engine.confirmSell(actualExitPrice);

        // Phase G: alert that the position was closed with net P&L.
        notifyTradeClosed(trade.symbol, netPnlAbsolute.toFixed(2), netPnlPercentage.toFixed(2), reason);

        return {
            success: true,
            tradeId,
            exitPrice: actualExitPrice,
            pnlAbsolute: netPnlAbsolute.toFixed(2),
            pnlPercentage: netPnlPercentage.toFixed(2),
            commission: sellCommission,
            status: orderResult.status,
            reason,
            message: 'Position closed on exchange. Net P&L recorded.',
        };
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('\u274c Error during confirmSell:', error.message);
        throw new Error(`Failed to close trade: ${error.message}`);
    } finally {
        dbClient.release();
    }
}

module.exports = { confirmBuy, confirmSell };

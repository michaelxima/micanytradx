// tradeController.js
// Human-in-the-loop trade actions. Each function runs a PostgreSQL
// transaction for data integrity, then drives the live engine's in-memory
// state so the WebSocket monitor and the database never drift apart.

const { pool } = require('./db');
const engine = require('./strategyEngine');

// ---------------------------------------------------------------------------
// confirmBuy
// Executes a pending BUY signal: marks it executed, opens a trade row, and
// flips the live engine into "in position" so it starts watching for SELL.
//
// confirmedPrice: the ACTUAL price the user confirmed at (avoids slippage vs.
//   the stale suggested_price). Falls back to the signal's suggested_price.
// ---------------------------------------------------------------------------
async function confirmBuy(signalId, quantity, userId, confirmedPrice = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch the pending signal
        const signalRes = await client.query(
            `SELECT * FROM signals WHERE id = $1 AND status = 'pending_review' FOR UPDATE`,
            [signalId]
        );
        if (signalRes.rows.length === 0) {
            throw new Error('Signal not found or already processed.');
        }
        const signal = signalRes.rows[0];

        // Use the confirmed live price if provided, else the suggested price.
        const entryPrice = confirmedPrice !== null
            ? confirmedPrice
            : parseFloat(signal.suggested_price);

        // 2. Mark the signal executed
        await client.query(
            `UPDATE signals SET status = 'executed', reviewed_at = NOW() WHERE id = $1`,
            [signalId]
        );

        // 3. Compute the stop-loss (2.5% below entry) and open the trade
        const stopLossPrice = entryPrice * (1 - 0.025);
        const tradeRes = await client.query(
            `INSERT INTO trades
                (signal_id, symbol, side, entry_price, quantity, stop_loss_price, status, opened_at)
             VALUES ($1, $2, 'LONG', $3, $4, $5, 'OPEN', NOW())
             RETURNING id`,
            [signalId, signal.symbol, entryPrice, quantity, stopLossPrice]
        );

        await client.query('COMMIT');

        // 4. ONLY after the DB commit, drive the live engine state.
        engine.confirmBuy(entryPrice);

        return {
            success: true,
            tradeId: tradeRes.rows[0].id,
            entryPrice,
            stopLossPrice,
            message: 'Trade executed, logged, and engine now monitoring for SELL.',
        };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Database error during confirmBuy:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// confirmSell
// Closes an OPEN trade: records exit price + P&L and flips the engine back
// to "flat" so it resumes looking for the next BUY.
// ---------------------------------------------------------------------------
async function confirmSell(tradeId, exitPrice = null, reason = 'manual') {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tradeRes = await client.query(
            `SELECT * FROM trades WHERE id = $1 AND status = 'OPEN' FOR UPDATE`,
            [tradeId]
        );
        if (tradeRes.rows.length === 0) {
            throw new Error('Open trade not found or already closed.');
        }
        const trade = tradeRes.rows[0];

        const livePrice = engine.getState().currentPrice;
        const resolvedExitPrice = (exitPrice !== null && exitPrice !== undefined)
            ? parseFloat(exitPrice)
            : (livePrice > 0 ? livePrice : parseFloat(trade.entry_price));

        const entry = parseFloat(trade.entry_price);
        const qty = parseFloat(trade.quantity);
        const pnlAbsolute = (resolvedExitPrice - entry) * qty;
        const pnlPercentage = ((resolvedExitPrice - entry) / entry) * 100;

        await client.query(
            `UPDATE trades
                SET status = 'CLOSED',
                    exit_price = $1,
                    pnl_absolute = $2,
                    pnl_percentage = $3,
                    closed_at = NOW()
              WHERE id = $4`,
            [resolvedExitPrice, pnlAbsolute, pnlPercentage, tradeId]
        );

        await client.query('COMMIT');

        // Drive the engine back to flat only after the DB commit.
        engine.confirmSell(resolvedExitPrice);

        return {
            success: true,
            tradeId,
            exitPrice: resolvedExitPrice,
            pnlAbsolute,
            pnlPercentage,
            reason,
            message: 'Trade closed, P&L recorded, engine back to monitoring for BUY.',
        };
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Database error during confirmSell:', error.message);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { confirmBuy, confirmSell };

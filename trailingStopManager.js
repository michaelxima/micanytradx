// trailingStopManager.js
// Phase E: Automated trailing stop-loss. Runs on an interval; for each open
// LONG position in profit past the activation threshold, it ratchets the
// stop-loss up toward the live price — never down — locking in gains while
// leaving upside uncapped.
require('dotenv').config();
const pool = require('./db');
const { client: binanceClient } = require('./exchangeManager');
const { notifyTrailingStop } = require('./notificationManager');

const TRAILING_CONFIG = {
    CHECK_INTERVAL_MS: parseInt(process.env.TRAIL_CHECK_INTERVAL_MS) || 10000, // every 10s
    ACTIVATION_PROFIT_PERCENT: parseFloat(process.env.TRAIL_ACTIVATION_PCT) || 1.0, // arm after +1%
    TRAIL_DISTANCE_PERCENT: parseFloat(process.env.TRAIL_DISTANCE_PCT) || 0.5, // trail 0.5% below high
};

let isRunning = false;
let intervalId = null;

function startTrailingStopManager() {
    if (isRunning) return;
    isRunning = true;
    console.log('\ud83d\udee1\ufe0f Trailing Stop Manager started.');

    intervalId = setInterval(async () => {
        try {
            await evaluateOpenPositions();
        } catch (error) {
            console.error('\u274c Error in Trailing Stop Manager loop:', error.message);
        }
    }, TRAILING_CONFIG.CHECK_INTERVAL_MS);

    // Don't let this timer keep the process alive on its own during shutdown.
    if (intervalId && typeof intervalId.unref === 'function') intervalId.unref();
}

function stopTrailingStopManager() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
    isRunning = false;
    console.log('\ud83d\uded1 Trailing Stop Manager stopped.');
}

function getStatus() {
    return { isRunning, config: { ...TRAILING_CONFIG } };
}

// Pure helper (exported for testing): decide the new stop-loss, if any.
// Returns the new SL when it should move up, otherwise null.
function computeTrailingStop(entryPrice, currentPrice, currentStopLoss, cfg = TRAILING_CONFIG) {
    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    if (profitPercent < cfg.ACTIVATION_PROFIT_PERCENT) return null;

    const newStopLoss = currentPrice * (1 - cfg.TRAIL_DISTANCE_PERCENT / 100);
    // Only ratchet UP — never move a stop-loss down.
    if (newStopLoss > currentStopLoss) {
        return parseFloat(newStopLoss.toFixed(8));
    }
    return null;
}

async function evaluateOpenPositions() {
    const dbClient = await pool.connect();
    try {
        const result = await dbClient.query(
            `SELECT id, symbol, entry_price, quantity, stop_loss_price
             FROM trades WHERE status = 'OPEN' AND side = 'LONG'`
        );
        if (result.rows.length === 0) return;

        for (const trade of result.rows) {
            try {
                const ticker = await binanceClient.ticker({ symbol: trade.symbol });
                const currentPrice = parseFloat(ticker.lastPrice);
                const entryPrice = parseFloat(trade.entry_price);
                const currentStopLoss = parseFloat(trade.stop_loss_price);

                const newStopLoss = computeTrailingStop(entryPrice, currentPrice, currentStopLoss);
                if (newStopLoss !== null) {
                    await dbClient.query(
                        `UPDATE trades SET stop_loss_price = $1 WHERE id = $2`,
                        [newStopLoss, trade.id]
                    );
                    const profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
                    console.log(
                        `\ud83d\udcc8 Trailing Stop Updated: ${trade.symbol} | ` +
                        `Old SL: ${currentStopLoss} -> New SL: ${newStopLoss.toFixed(2)} ` +
                        `(Profit: ${profitPercent.toFixed(2)}%)`
                    );
                    // Phase G: alert that the stop was ratcheted up.
                    notifyTrailingStop(
                        trade.symbol,
                        Number(currentStopLoss).toFixed(2),
                        newStopLoss.toFixed(2),
                        profitPercent.toFixed(2)
                    );
                    // TODO: push notification — "Stop loss moved up / to break-even".
                }
            } catch (err) {
                console.warn(`Could not evaluate trailing stop for ${trade.symbol}:`, err.message);
            }
        }
    } finally {
        dbClient.release();
    }
}

module.exports = {
    startTrailingStopManager,
    stopTrailingStopManager,
    getStatus,
    computeTrailingStop,
    evaluateOpenPositions,
    TRAILING_CONFIG,
};

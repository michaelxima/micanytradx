// analyticsController.js
// Phase D: Real-time monitoring & analytics. Turns raw trade rows into
// quant-desk metrics.
//
//   Module 1  getPerformanceMetrics  — win rate, profit factor, net P&L
//   Module 2  getSlippageAnalysis     — suggested price vs. actual fill
//   Module 3  getLiveUnrealizedPnL     — live ticking P&L for open positions
require('dotenv').config();
const pool = require('./db');
const { client: binanceClient } = require('./exchangeManager');

// ==========================================
// MODULE 1: Trade Performance Metrics
// ==========================================
async function getPerformanceMetrics() {
    try {
        const result = await pool.query(`
            WITH trade_stats AS (
                SELECT
                    COUNT(*) FILTER (WHERE status = 'CLOSED') AS total_closed,
                    COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl_absolute > 0) AS winning_trades,
                    COUNT(*) FILTER (WHERE status = 'CLOSED' AND pnl_absolute < 0) AS losing_trades,
                    COALESCE(SUM(pnl_absolute) FILTER (WHERE status = 'CLOSED' AND pnl_absolute > 0), 0) AS gross_profit,
                    COALESCE(ABS(SUM(pnl_absolute) FILTER (WHERE status = 'CLOSED' AND pnl_absolute < 0)), 0) AS gross_loss,
                    COALESCE(SUM(pnl_absolute) FILTER (WHERE status = 'CLOSED'), 0) AS net_pnl
                FROM trades
            )
            SELECT
                total_closed,
                winning_trades,
                losing_trades,
                CASE WHEN total_closed > 0
                     THEN ROUND((winning_trades::numeric / total_closed::numeric) * 100, 2)
                     ELSE 0 END AS win_rate,
                CASE WHEN gross_loss > 0
                     THEN ROUND(gross_profit::numeric / gross_loss::numeric, 2)
                     ELSE gross_profit END AS profit_factor,
                ROUND(net_pnl::numeric, 2) AS net_pnl
            FROM trade_stats;
        `);
        return result.rows[0];
    } catch (error) {
        console.error('Error fetching performance metrics:', error.message);
        throw error;
    }
}

// ==========================================
// MODULE 2: Slippage & Execution Analysis
// ==========================================
async function getSlippageAnalysis() {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(t.id) AS total_executed,
                ROUND(AVG(ABS(t.entry_price - s.suggested_price) / NULLIF(s.suggested_price, 0) * 100), 4) AS avg_slippage_percent,
                ROUND(MIN(ABS(t.entry_price - s.suggested_price) / NULLIF(s.suggested_price, 0) * 100), 4) AS best_slippage_percent,
                ROUND(MAX(ABS(t.entry_price - s.suggested_price) / NULLIF(s.suggested_price, 0) * 100), 4) AS worst_slippage_percent
            FROM trades t
            JOIN signals s ON t.signal_id = s.id
            WHERE t.status IN ('OPEN', 'CLOSED') AND s.suggested_price > 0;
        `);
        return result.rows[0];
    } catch (error) {
        console.error('Error fetching slippage analysis:', error.message);
        throw error;
    }
}

// ==========================================
// MODULE 3: Live Unrealized P&L
// ==========================================
async function getLiveUnrealizedPnL() {
    try {
        // 1. Open trades.
        const tradesRes = await pool.query(`
            SELECT id, symbol, side, entry_price, quantity, commission, stop_loss_price
            FROM trades WHERE status = 'OPEN'
        `);
        if (tradesRes.rows.length === 0) return [];

        // 2. Fetch a live price per DISTINCT symbol (avoid duplicate API calls).
        const livePrices = {};
        const symbols = [...new Set(tradesRes.rows.map((t) => t.symbol))];
        for (const symbol of symbols) {
            try {
                const ticker = await binanceClient.ticker({ symbol });
                livePrices[symbol] = parseFloat(ticker.lastPrice);
            } catch (err) {
                console.warn(`Could not fetch live price for ${symbol}:`, err.message);
            }
        }

        // 3. Unrealized P&L per position.
        return tradesRes.rows.map((trade) => {
            const currentPrice = livePrices[trade.symbol] || parseFloat(trade.entry_price);
            const entry = parseFloat(trade.entry_price);
            const qty = parseFloat(trade.quantity);
            const commission = parseFloat(trade.commission || 0);

            const unrealizedPnl = trade.side === 'LONG'
                ? ((currentPrice - entry) * qty) - commission
                : ((entry - currentPrice) * qty) - commission;

            // Guard against divide-by-zero when entry/qty are missing.
            const denom = entry * qty;
            const pnlPercent = denom !== 0 ? (unrealizedPnl / denom) * 100 : 0;

            return {
                tradeId: trade.id,
                symbol: trade.symbol,
                side: trade.side,
                entryPrice: entry,
                currentPrice,
                quantity: qty,
                stopLossPrice: trade.stop_loss_price != null ? parseFloat(trade.stop_loss_price) : null,
                unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
                unrealizedPnlPercent: parseFloat(pnlPercent.toFixed(2)),
            };
        });
    } catch (error) {
        console.error('Error fetching live unrealized P&L:', error.message);
        throw error;
    }
}

module.exports = {
    getPerformanceMetrics,
    getSlippageAnalysis,
    getLiveUnrealizedPnL,
};

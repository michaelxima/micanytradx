// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connect: connectEngine, getWsManager } = require('./strategyEngine');
const { confirmBuy, confirmSell } = require('./tradeController');
const { registerGracefulShutdown } = require('./infrastructureManager');
const { haltTrading } = require('./riskManager');
const { startTrailingStopManager, stopTrailingStopManager } = require('./trailingStopManager');
const {
    getPerformanceMetrics,
    getSlippageAnalysis,
    getLiveUnrealizedPnL,
} = require('./analyticsController');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// CORS: lock to known origins in production. Set CORS_ORIGINS in the Railway
// environment to a comma-separated allowlist (e.g. your Vercel URL). If unset,
// we fall back to permissive mode for local development only.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
    cors(
        allowedOrigins.length > 0
            ? {
                  origin(origin, callback) {
                      // Allow same-origin / server-to-server (no Origin header)
                      // and any explicitly allowlisted origin.
                      if (!origin || allowedOrigins.includes(origin)) {
                          return callback(null, true);
                      }
                      return callback(new Error(`CORS: origin not allowed: ${origin}`));
                  },
              }
            : undefined // dev: permissive
    )
);
app.use(express.json()); // Parses incoming JSON requests

if (allowedOrigins.length > 0) {
    console.log('🔒 CORS locked to:', allowedOrigins.join(', '));
} else {
    console.warn('⚠️  CORS is permissive (no CORS_ORIGINS set) — set it in production.');
}

// ==========================================
// 1. START THE BRAIN (Strategy Engine)
// ==========================================
console.log('🧠 Initializing Strategy Engine & WebSocket connection...');
connectEngine();

// Phase E: start the trailing-stop background loop.
startTrailingStopManager();

// Phase C: register SIGINT/SIGTERM handlers so the process halts trading,
// closes the WebSocket, and drains the DB pool before exiting.
// The WS manager is created asynchronously inside the engine, so we rely on
// the global.wsManager fallback (resolved at shutdown time) rather than
// capturing a possibly-null reference now.
void getWsManager; // (engine also sets global.wsManager)
registerGracefulShutdown({ onHalt: haltTrading, onStop: stopTrailingStopManager });

// ==========================================
// 2. API ROUTES (The Nervous System)
// ==========================================

// HEALTH CHECK
app.get('/api/health', (req, res) => {
    res.json({ status: 'online', message: 'Trading Engine API is running.' });
});

// GET PENDING SIGNALS (What the app suggests you review)
app.get('/api/signals/pending', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*, st.name as strategy_name 
             FROM signals s 
             LEFT JOIN strategies st ON s.strategy_id = st.id 
             WHERE s.status = 'pending_review' 
             ORDER BY s.generated_at DESC`
        );
        res.json({ success: true, count: result.rows.length, signals: result.rows });
    } catch (error) {
        console.error('Error fetching pending signals:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// POST CONFIRM BUY (The Human-in-the-Loop Trigger)
app.post('/api/trades/confirm-buy', async (req, res) => {
    try {
        const { signalId, userId, confirmedPrice } = req.body;

        if (!signalId) {
            return res.status(400).json({ success: false, error: 'signalId is required.' });
        }

        // Position size is now owned by the risk manager (Phase A/B), so the
        // client no longer sends quantity — just the signal to act on.
        const result = await confirmBuy(signalId, userId || 'in-house-user', confirmedPrice);
        res.json(result);
    } catch (error) {
        console.error('Error confirming buy:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST CONFIRM SELL (The Exit Trigger)
app.post('/api/trades/confirm-sell', async (req, res) => {
    try {
        const { tradeId, exitPrice, reason } = req.body;
        
        if (!tradeId) {
            return res.status(400).json({ success: false, error: 'tradeId is required.' });
        }

        const result = await confirmSell(tradeId, exitPrice, reason || 'manual');
        res.json(result);
    } catch (error) {
        console.error('Error confirming sell:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET OPEN TRADES (Positions currently being monitored for SELL signals)
app.get('/api/trades/open', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM trades WHERE status = 'OPEN' ORDER BY opened_at DESC`
        );
        res.json({ success: true, count: result.rows.length, trades: result.rows });
    } catch (error) {
        console.error('Error fetching open trades:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ==========================================
// ANALYTICS ROUTES (Phase D)
// ==========================================

// GET performance metrics (win rate, profit factor, net P&L)
app.get('/api/analytics/performance', async (req, res) => {
    try {
        const metrics = await getPerformanceMetrics();
        res.json({ success: true, data: metrics });
    } catch (error) {
        console.error('Error fetching performance metrics:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET slippage / execution analysis
app.get('/api/analytics/slippage', async (req, res) => {
    try {
        const slippage = await getSlippageAnalysis();
        res.json({ success: true, data: slippage });
    } catch (error) {
        console.error('Error fetching slippage analysis:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET live unrealized P&L for open positions
app.get('/api/trades/unrealized', async (req, res) => {
    try {
        const livePositions = await getLiveUnrealizedPnL();
        res.json({ success: true, data: livePositions });
    } catch (error) {
        console.error('Error fetching unrealized P&L:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 3. START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`🚀 API Server running on http://localhost:${PORT}`);
    console.log(`📡 Endpoints available:`);
    console.log(`   - GET  /api/health`);
    console.log(`   - GET  /api/signals/pending`);
    console.log(`   - POST /api/trades/confirm-buy`);
    console.log(`   - POST /api/trades/confirm-sell`);
    console.log(`   - GET  /api/trades/open`);
    console.log(`   - GET  /api/trades/unrealized`);
    console.log(`   - GET  /api/analytics/performance`);
    console.log(`   - GET  /api/analytics/slippage`);
});

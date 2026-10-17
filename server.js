// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connect: connectEngine } = require('./strategyEngine');
const { confirmBuy, confirmSell } = require('./tradeController');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allows your future mobile/web frontend to talk to this API
app.use(express.json()); // Parses incoming JSON requests

// ==========================================
// 1. START THE BRAIN (Strategy Engine)
// ==========================================
console.log('🧠 Initializing Strategy Engine & WebSocket connection...');
connectEngine();

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
        const { signalId, quantity, userId, confirmedPrice } = req.body;
        
        if (!signalId || !quantity) {
            return res.status(400).json({ success: false, error: 'signalId and quantity are required.' });
        }

        // Call the tradeController function we built in Phase 1
        const result = await confirmBuy(signalId, quantity, userId || 'in-house-user', confirmedPrice); 
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
});

-- schema.sql
-- MicanyTradx database schema. Run once against your Neon database.
-- Tracks the full lifecycle: strategy -> signal -> trade.

-- 1. Enable UUID extension for secure, non-sequential IDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Users Table (good practice for scaling, even in-house)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(50) UNIQUE NOT NULL,
    api_key_encrypted TEXT, -- Never store plain text API keys!
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Strategies Table (track which logic generated the signal)
CREATE TABLE IF NOT EXISTS strategies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL, -- e.g., 'EMA Pullback Momentum'
    description TEXT,
    parameters JSONB, -- e.g., {"ema_fast": 9, "ema_slow": 21, "rsi_max": 65}
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Signals Table (the app's suggestion, waiting for YOUR review)
CREATE TABLE IF NOT EXISTS signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    strategy_id UUID REFERENCES strategies(id),
    symbol VARCHAR(20) NOT NULL, -- e.g., 'BTCUSDT'
    signal_type VARCHAR(10) CHECK (signal_type IN ('BUY', 'SELL')),
    suggested_price DECIMAL(18, 8) NOT NULL,
    rsi_at_signal DECIMAL(5, 2),
    ema_fast_at_signal DECIMAL(18, 8),
    ema_slow_at_signal DECIMAL(18, 8),
    status VARCHAR(20) DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'executed', 'ignored', 'expired')),
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP WITH TIME ZONE
);

-- 5. Trades Table (the actual executed position, tracking P&L)
CREATE TABLE IF NOT EXISTS trades (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    signal_id UUID REFERENCES signals(id),
    symbol VARCHAR(20) NOT NULL,
    side VARCHAR(10) CHECK (side IN ('LONG', 'SHORT')),
    entry_price DECIMAL(18, 8) NOT NULL,
    exit_price DECIMAL(18, 8),
    quantity DECIMAL(18, 8) NOT NULL,
    stop_loss_price DECIMAL(18, 8),
    take_profit_price DECIMAL(18, 8),
    status VARCHAR(20) DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
    pnl_percentage DECIMAL(10, 4), -- Calculated on exit
    pnl_absolute DECIMAL(18, 8),   -- Calculated on exit
    opened_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for fast querying (crucial for real-time dashboards)
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

-- Seed the default strategy so signals have something to reference.
INSERT INTO strategies (name, description, parameters)
SELECT
    'EMA Pullback Momentum',
    'EMA9/EMA21 bullish cross with RSI < 65 entry; EMA cross-down or 2.5% stop exit.',
    '{"ema_fast": 9, "ema_slow": 21, "rsi_max": 65, "stop_loss_pct": 2.5}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM strategies WHERE name = 'EMA Pullback Momentum');

// scripts/addFeeColumns.js
// Phase B migration: adds commission tracking columns to the trades table so
// P&L can be calculated net of real trading fees.
// Idempotent — safe to run multiple times.  Run with:  node scripts/addFeeColumns.js
require('dotenv').config();
const { Pool } = require('pg');

async function migrate() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    try {
        await pool.query(
            `ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission DECIMAL(18, 8) DEFAULT 0`
        );
        await pool.query(
            `ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission_asset VARCHAR(10) DEFAULT 'USDT'`
        );
        console.log('\u2705 commission + commission_asset columns added to trades table');
    } catch (err) {
        console.error('Error:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

migrate();

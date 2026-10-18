// scripts/addExchangeOrderId.js
// One-time migration: adds exchange_order_id column to trades table.
require('dotenv').config();
const { Pool } = require('pg');

async function migrate() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    try {
        await pool.query(
            'ALTER TABLE trades ADD COLUMN IF NOT EXISTS exchange_order_id VARCHAR(64)'
        );
        console.log('✅ exchange_order_id column added to trades table');
    } catch (err) {
        console.error('Error:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

migrate();

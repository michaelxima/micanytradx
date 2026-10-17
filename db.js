// db.js
// PostgreSQL connection pool — shared across the app.
// Reads DATABASE_URL from the environment (.env in development).

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Neon (and most cloud Postgres) require SSL.
    ssl: { rejectUnauthorized: false },
});

// Surface pool-level errors instead of crashing silently.
pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Small helper so callers can do a quick connectivity test.
async function testConnection() {
    const res = await pool.query('SELECT NOW() AS now');
    return res.rows[0].now;
}

pool.pool = pool;
pool.testConnection = testConnection;

module.exports = pool;

// scripts/initDb.js
// Applies schema.sql to the database in DATABASE_URL, then verifies the
// tables exist. Run with:  npm run db:init
//
// This replaces needing the psql CLI on Windows — it uses the same pg
// driver the app already depends on.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env first.');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    const client = await pool.connect();
    try {
        console.log('Connected. Applying schema.sql ...');
        await client.query(sql);
        console.log('Schema applied successfully.\n');

        // Verify: list the tables we expect.
        const res = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        console.log('Tables now in the database:');
        res.rows.forEach((r) => console.log('  -', r.table_name));

        const expected = ['users', 'strategies', 'signals', 'trades'];
        const found = res.rows.map((r) => r.table_name);
        const missing = expected.filter((t) => !found.includes(t));
        if (missing.length === 0) {
            console.log('\n==> SUCCESS: all 4 expected tables exist.');
        } else {
            console.log('\n==> WARNING: missing tables:', missing.join(', '));
        }
    } catch (err) {
        console.error('Error applying schema:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();

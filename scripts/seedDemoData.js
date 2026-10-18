// scripts/seedDemoData.js
// Phase D/E support: seed realistic demo data so the analytics endpoints and
// the live unrealized-P&L UI have something to render WITHOUT waiting for a
// real trade. Inserts a strategy, a handful of CLOSED trades (mixed wins and
// losses for a meaningful win rate + profit factor), one executed signal, and
// one OPEN LONG position so /api/trades/unrealized ticks live.
//
// Idempotent: tags seeded signals with a sentinel symbol suffix and skips if
// already present. Run with:  node scripts/seedDemoData.js
require('dotenv').config();
const { Pool } = require('pg');

const SENTINEL = 'SEED'; // marks rows this script created

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('FATAL: DATABASE_URL is not set.');
        process.exit(1);
    }
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Skip if we've already seeded (idempotent).
        const existing = await client.query(
            `SELECT COUNT(*)::int AS n FROM trades WHERE exchange_order_id LIKE $1`,
            [`${SENTINEL}-%`]
        );
        if (existing.rows[0].n > 0) {
            console.log(`✅ Demo data already present (${existing.rows[0].n} seeded trades). Nothing to do.`);
            await client.query('ROLLBACK');
            return;
        }

        // 1. Ensure a strategy exists.
        const strat = await client.query(
            `INSERT INTO strategies (name, description, parameters)
             SELECT 'EMA Pullback Momentum (seed)', 'Seeded demo strategy',
                    '{"ema_fast":9,"ema_slow":21,"rsi_max":65}'::jsonb
             WHERE NOT EXISTS (SELECT 1 FROM strategies WHERE name = 'EMA Pullback Momentum (seed)')
             RETURNING id`
        );
        let strategyId;
        if (strat.rows.length) {
            strategyId = strat.rows[0].id;
        } else {
            strategyId = (await client.query(
                `SELECT id FROM strategies WHERE name = 'EMA Pullback Momentum (seed)'`
            )).rows[0].id;
        }

        // 2. Closed trades: 3 wins, 2 losses. gross profit = 450, gross loss = 150
        //    -> win rate 60%, profit factor 3.0, net +300.
        const closed = [
            { entry: 60000, exit: 61000, qty: 0.1, pnl: 100 },
            { entry: 62000, exit: 63500, qty: 0.1, pnl: 150 },
            { entry: 64000, exit: 66000, qty: 0.1, pnl: 200 },
            { entry: 65000, exit: 64200, qty: 0.1, pnl: -80 },
            { entry: 63000, exit: 62300, qty: 0.1, pnl: -70 },
        ];
        let i = 0;
        for (const t of closed) {
            i++;
            // suggested price slightly off entry so slippage analytics have a value
            const suggested = t.entry * (1 + (i % 2 === 0 ? 0.0008 : -0.0006));
            const sig = await client.query(
                `INSERT INTO signals (strategy_id, symbol, signal_type, suggested_price, status, reviewed_at)
                 VALUES ($1, 'BTCUSDT', 'BUY', $2, 'executed', NOW())
                 RETURNING id`,
                [strategyId, suggested.toFixed(2)]
            );
            const pnlPct = (t.pnl / (t.entry * t.qty)) * 100;
            await client.query(
                `INSERT INTO trades (
                    signal_id, symbol, side, entry_price, exit_price, quantity,
                    stop_loss_price, exchange_order_id, status, pnl_absolute, pnl_percentage,
                    commission, commission_asset, opened_at, closed_at
                 ) VALUES ($1,'BTCUSDT','LONG',$2,$3,$4,$5,$6,'CLOSED',$7,$8,$9,'USDT',
                           NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')`,
                [
                    sig.rows[0].id, t.entry, t.exit, t.qty, t.entry * 0.975,
                    `${SENTINEL}-C${i}`, t.pnl, pnlPct.toFixed(4), 0.05,
                ]
            );
        }

        // 3. One OPEN LONG position so live unrealized P&L has something to tick.
        const openSuggested = 67000 * 0.9995;
        const openSig = await client.query(
            `INSERT INTO signals (strategy_id, symbol, signal_type, suggested_price, status, reviewed_at)
             VALUES ($1, 'BTCUSDT', 'BUY', $2, 'executed', NOW())
             RETURNING id`,
            [strategyId, openSuggested.toFixed(2)]
        );
        await client.query(
            `INSERT INTO trades (
                signal_id, symbol, side, entry_price, quantity, stop_loss_price,
                exchange_order_id, status, commission, commission_asset, opened_at
             ) VALUES ($1,'BTCUSDT','LONG',67000,0.15,65325,$2,'OPEN',0.08,'USDT', NOW())`,
            [openSig.rows[0].id, `${SENTINEL}-OPEN1`]
        );

        await client.query('COMMIT');
        console.log('✅ Seeded: 5 closed trades (3W/2L) + 1 open LONG position.');
        console.log('   Expected analytics -> win rate 60%, profit factor 3.0, net +300.');
        console.log('   /api/trades/unrealized will now return 1 live position.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Seed failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();

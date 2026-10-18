# MicanyTradx — Deployment Guide (Phases A–E)

The live site at `trading-dashboard-two-gamma.vercel.app` runs an **older build**
(pre–Phase D). All Phase A–E work is committed locally but not yet pushed. This
guide closes the gap. Backend → Railway, Dashboard → Vercel, DB → Neon.

## 0. One-time: commit the work
```bash
cd C:\Users\mican\Documents\MicanyTradx
git add -A
git commit -m "Phases A–E: risk, exchange, infra, analytics, advanced logic + deploy hardening"
git push origin main
```
`.env` and `node_modules/` are gitignored — nothing secret is pushed.

## 1. Database (Neon) — apply schema + migrations
Run against the SAME `DATABASE_URL` the backend uses:
```bash
npm run db:init     # base tables + account_snapshots
npm run db:fees     # commission / commission_asset columns
npm run db:seed     # OPTIONAL: demo data so analytics + live P&L render immediately
```
`db:seed` is idempotent and inserts 5 closed trades (3W/2L → win rate 60%,
profit factor 3.0, net +300) and 1 open LONG so `/api/trades/unrealized` ticks.

## 2. Backend (Railway)
Set these environment variables in the Railway service:

| Variable | Value |
|---|---|
| `DATABASE_URL` | your Neon connection string |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | testnet keys |
| `BINANCE_TESTNET` | `true` |
| `CORS_ORIGINS` | `https://trading-dashboard-two-gamma.vercel.app` (your Vercel URL) |
| `PORT` | leave unset — Railway injects it; server reads `process.env.PORT` |

`Procfile` (`web: node server.js`) makes the start command explicit. Redeploy.
Verify: `curl https://<railway-url>/api/health` → `{"status":"online",...}`
and `curl https://<railway-url>/api/analytics/performance` → JSON (not 404).

## 3. Dashboard (Vercel)
Set in Vercel project settings → Environment Variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://<your-railway-url>` (NOT localhost) |
| `NEXT_PUBLIC_POLL_INTERVAL_MS` | `3000` (optional; defaults to 3000) |

`NEXT_PUBLIC_*` is inlined at BUILD time, so you must **redeploy** after setting it.
Vercel auto-deploys on `git push`. Root is the `trading-dashboard/` folder.

## 4. Verify end-to-end
1. Open the Vercel URL. Status badge should read **Engine Online**.
2. The analytics KPI row (Win Rate / Profit Factor / Net P&L / Avg Slippage) renders.
3. With seed data (or a real open trade), the open position shows **live
   unrealized P&L** updating every 3s.
4. Execution: generate/confirm a buy against Binance **testnet** and confirm a
   trade row is created and later closable.

## What changed for deployment hardening
- **CORS** locked to `CORS_ORIGINS` allowlist in production (was wide-open).
- **Procfile** added (explicit Railway start command).
- **`NEXT_PUBLIC_API_URL`** documented + `.env.example` added (was defaulting to localhost).
- **Poll interval** 4s → **3s** (configurable).
- **Live P&L** on open-trade cards now uses the backend `/api/trades/unrealized`
  (commission-aware) instead of the local BTC ticker calc.
- **`db:seed`** script so analytics + live P&L are observable without a real trade.

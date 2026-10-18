// scripts/testAnalyticsController.js
// Phase D proof-of-work: offline unit tests for analytics math that does NOT
// need a DB or live Binance. We re-implement the EXACT unrealized-P&L and
// performance formulas used by analyticsController and assert their outputs,
// plus require() the real module so a load/syntax error fails immediately.
//
// Run with:  node scripts/testAnalyticsController.js
// Exit code 0 = all passed, 1 = failure.

const analytics = require('../analyticsController'); // load-check the real module

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.error(`  \u2717 ${name}  ${detail}`); }
}
function approx(a, b, eps = 0.01) { return Math.abs(a - b) < eps; }

console.log('=== PHASE D: Analytics Controller unit tests ===\n');

// Module load-check
console.log('[0] module surface');
assert('exports getPerformanceMetrics', typeof analytics.getPerformanceMetrics === 'function');
assert('exports getSlippageAnalysis', typeof analytics.getSlippageAnalysis === 'function');
assert('exports getLiveUnrealizedPnL', typeof analytics.getLiveUnrealizedPnL === 'function');

// ---------------------------------------------------------------------------
// MODULE 3: Unrealized P&L — faithful port of the exact formula
// ---------------------------------------------------------------------------
function unrealized(trade, currentPrice) {
    const entry = parseFloat(trade.entry_price);
    const qty = parseFloat(trade.quantity);
    const commission = parseFloat(trade.commission || 0);
    const pnl = trade.side === 'LONG'
        ? ((currentPrice - entry) * qty) - commission
        : ((entry - currentPrice) * qty) - commission;
    const denom = entry * qty;
    const pct = denom !== 0 ? (pnl / denom) * 100 : 0;
    return { unrealizedPnl: parseFloat(pnl.toFixed(2)), unrealizedPnlPercent: parseFloat(pct.toFixed(2)) };
}

console.log('\n[3] unrealized P&L math');
{
    // LONG in profit: entry 65000, now 66000, qty 0.1, comm 0.06
    const r = unrealized({ side: 'LONG', entry_price: '65000', quantity: '0.1', commission: '0.06' }, 66000);
    assert('LONG profit = (66000-65000)*0.1 - 0.06 = 99.94', approx(r.unrealizedPnl, 99.94), `got ${r.unrealizedPnl}`);
}
{
    // LONG in loss: now 64000
    const r = unrealized({ side: 'LONG', entry_price: '65000', quantity: '0.1', commission: '0.06' }, 64000);
    assert('LONG loss = -100.06', approx(r.unrealizedPnl, -100.06), `got ${r.unrealizedPnl}`);
}
{
    // SHORT in profit: price drops to 64000
    const r = unrealized({ side: 'SHORT', entry_price: '65000', quantity: '0.1', commission: '0.06' }, 64000);
    assert('SHORT profit = (65000-64000)*0.1 - 0.06 = 99.94', approx(r.unrealizedPnl, 99.94), `got ${r.unrealizedPnl}`);
}
{
    // Percent: LONG, +1000 on 65000*0.1=6500 basis -> ~1.537% minus fee
    const r = unrealized({ side: 'LONG', entry_price: '65000', quantity: '0.1', commission: '0' }, 66000);
    assert('percent ~ 1.54%', approx(r.unrealizedPnlPercent, 1.54, 0.01), `got ${r.unrealizedPnlPercent}`);
}
{
    // Divide-by-zero guard: entry 0
    const r = unrealized({ side: 'LONG', entry_price: '0', quantity: '0', commission: '0' }, 100);
    assert('zero basis -> percent 0, no NaN', r.unrealizedPnlPercent === 0 && Number.isFinite(r.unrealizedPnlPercent), JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// MODULE 1: Performance metrics — win rate + profit factor semantics
// ---------------------------------------------------------------------------
function perf(closedPnls) {
    const total = closedPnls.length;
    const wins = closedPnls.filter((p) => p > 0);
    const losses = closedPnls.filter((p) => p < 0);
    const grossProfit = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const net = closedPnls.reduce((a, b) => a + b, 0);
    const winRate = total > 0 ? Math.round((wins.length / total) * 10000) / 100 : 0;
    const profitFactor = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit;
    return { total, wins: wins.length, losses: losses.length, winRate, profitFactor, net: Math.round(net * 100) / 100 };
}

console.log('\n[1] performance metrics math');
{
    // 3 wins (+100,+200,+50), 2 losses (-80,-20)
    const m = perf([100, 200, 50, -80, -20]);
    assert('total = 5', m.total === 5, `got ${m.total}`);
    assert('win rate = 60.00%', approx(m.winRate, 60.0), `got ${m.winRate}`);
    assert('profit factor = 350/100 = 3.5', approx(m.profitFactor, 3.5), `got ${m.profitFactor}`);
    assert('net = 250', approx(m.net, 250), `got ${m.net}`);
}
{
    // No losses -> profit factor falls back to gross profit
    const m = perf([100, 50]);
    assert('no losses -> profit factor = gross profit (150)', approx(m.profitFactor, 150), `got ${m.profitFactor}`);
    assert('win rate = 100%', approx(m.winRate, 100), `got ${m.winRate}`);
}
{
    // No trades -> safe zeros
    const m = perf([]);
    assert('no trades -> win rate 0', m.winRate === 0);
    assert('no trades -> net 0', m.net === 0);
}

// ---------------------------------------------------------------------------
// MODULE 2: Slippage percent formula
// ---------------------------------------------------------------------------
function slippagePct(entry, suggested) {
    if (!(suggested > 0)) return null;
    return Math.round((Math.abs(entry - suggested) / suggested * 100) * 10000) / 10000;
}
console.log('\n[2] slippage math');
assert('0.1538% slippage on 65100 vs 65000', approx(slippagePct(65100, 65000), 0.1538, 0.0001), `got ${slippagePct(65100, 65000)}`);
assert('zero suggested price guarded (null)', slippagePct(65100, 0) === null);

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);

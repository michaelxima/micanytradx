// scripts/testRiskManager.js
// Phase A proof-of-work: offline unit tests for the Risk Manager.
// Tests the PURE logic (position sizing + halt/resume state machine) that
// does not require a database or a live Binance connection.
//
// Run with:  node scripts/testRiskManager.js
// Exit code 0 = all passed, 1 = a failure (so it is CI-friendly).

const rm = require('../riskManager');

let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  \u2713 ${name}`);
    } else {
        failed++;
        console.error(`  \u2717 ${name}  ${detail}`);
    }
}

function approx(a, b, eps = 0.01) {
    return Math.abs(a - b) < eps;
}

console.log('=== PHASE A: Risk Manager unit tests ===\n');

// ---------------------------------------------------------------------------
// 1. calculatePositionSize — core money-management math
// ---------------------------------------------------------------------------
console.log('[1] calculatePositionSize');
{
    // 2% of 10,000 = $200 risk; stop distance 1625 -> qty ~0.12307692
    const r = rm.calculatePositionSize(10000, 65000, 63375);
    assert('risks exactly 2% of balance', approx(r.riskPercentage, 2.0), `got ${r.riskPercentage}`);
    assert('risk amount is $200', approx(r.riskAmount, 200), `got ${r.riskAmount}`);
    assert('quantity sized to stop distance', approx(r.quantity, 0.12307692, 1e-6), `got ${r.quantity}`);
    assert('position value = qty * entry', approx(r.positionValue, r.quantity * 65000, 1), `got ${r.positionValue}`);
}
{
    // Zero stop distance must NOT divide by zero — must return a safe zero.
    const r = rm.calculatePositionSize(10000, 65000, 65000);
    assert('zero stop distance returns qty 0 (no NaN/Infinity)',
        r.quantity === 0 && Number.isFinite(r.quantity), JSON.stringify(r));
}
{
    // Smaller account, tighter stop
    const r = rm.calculatePositionSize(5000, 2000, 1950);
    assert('ETH-like sizing risks 2%', approx(r.riskPercentage, 2.0), `got ${r.riskPercentage}`);
    assert('ETH-like quantity = 2.0', approx(r.quantity, 2.0, 1e-6), `got ${r.quantity}`);
}

// ---------------------------------------------------------------------------
// 2. Halt / resume state machine
// ---------------------------------------------------------------------------
console.log('\n[2] halt / resume state machine');
{
    let s = rm.getRiskStatus();
    assert('starts not halted', s.isTradingHalted === false, JSON.stringify(s));

    rm.haltTrading('unit-test halt');
    s = rm.getRiskStatus();
    assert('haltTrading sets halted flag', s.isTradingHalted === true);
    assert('haltTrading records reason', s.haltReason === 'unit-test halt', s.haltReason);

    rm.resumeTrading();
    s = rm.getRiskStatus();
    assert('resumeTrading clears halt', s.isTradingHalted === false);
    assert('resumeTrading clears reason', s.haltReason === null);
}

// ---------------------------------------------------------------------------
// 3. getRiskStatus config surface
// ---------------------------------------------------------------------------
console.log('\n[3] getRiskStatus config');
{
    const s = rm.getRiskStatus();
    assert('exposes riskPerTrade', typeof s.config.riskPerTrade === 'number');
    assert('exposes maxPositions', typeof s.config.maxPositions === 'number');
    assert('exposes dailyLossLimit', typeof s.config.dailyLossLimit === 'number');
    assert('exposes maxDrawdown', typeof s.config.maxDrawdown === 'number');
    assert('exposes minimumBalance', typeof s.config.minimumBalance === 'number');
}

// ---------------------------------------------------------------------------
// 4. performRiskCheck short-circuits when halted (no DB/Binance needed)
// ---------------------------------------------------------------------------
console.log('\n[4] performRiskCheck respects halt state');
(async () => {
    rm.haltTrading('blocking for test');
    const res = await rm.performRiskCheck(65000, 63375);
    assert('canTrade is false while halted', res.canTrade === false, JSON.stringify(res));
    assert('reason mentions halt', res.reasons.join(' ').toLowerCase().includes('halt'), res.reasons.join(' '));
    rm.resumeTrading();

    // ---- summary ----
    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
})();

// scripts/testAdvancedLogic.js
// Phase E proof-of-work: offline unit tests for the advanced trading logic.
// Covers MTF confirmation, volume-regime filter, and the trailing-stop
// ratchet math. No DB or live Binance needed.
//
// Run with:  node scripts/testAdvancedLogic.js
// Exit code 0 = all passed, 1 = failure.

const { checkHigherTimeframeTrend, checkVolumeRegime } = require('../marketAnalyzer');
const { computeTrailingStop } = require('../trailingStopManager');

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.error(`  \u2717 ${name}  ${detail}`); }
}
function approx(a, b, eps = 0.01) { return Math.abs(a - b) < eps; }

console.log('=== PHASE E: Advanced Logic unit tests ===\n');

// ---------------------------------------------------------------------------
// MODULE 1: MTF confirmation
// ---------------------------------------------------------------------------
console.log('[1] checkHigherTimeframeTrend');
{
    // 51 steadily rising prices -> last price above the 50-EMA -> bullish.
    const rising = Array.from({ length: 51 }, (_, i) => 100 + i);
    const r = checkHigherTimeframeTrend(rising);
    assert('rising series -> bullish 1h trend', r.isBullishHigherTrend === true, JSON.stringify(r));
    assert('reports current1hEma', typeof r.current1hEma === 'number');
}
{
    // Falling series -> last price below EMA -> not bullish.
    const falling = Array.from({ length: 51 }, (_, i) => 200 - i);
    const r = checkHigherTimeframeTrend(falling);
    assert('falling series -> not bullish', r.isBullishHigherTrend === false, JSON.stringify(r));
}
{
    // Too little data -> guarded.
    const r = checkHigherTimeframeTrend([100, 101, 102]);
    assert('insufficient data guarded', r.isBullishHigherTrend === false && r.reason === 'Insufficient 1h data', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// MODULE 2: Volume regime
// ---------------------------------------------------------------------------
console.log('\n[2] checkVolumeRegime');
{
    const volumes = Array(20).fill(100); // avg 100
    const high = checkVolumeRegime(volumes, 160); // 1.6x
    assert('1.6x average -> high volume', high.isHighVolume === true, JSON.stringify(high));
    assert('volumeRatio = 1.6', approx(high.volumeRatio, 1.6), `got ${high.volumeRatio}`);
}
{
    const volumes = Array(20).fill(100);
    const low = checkVolumeRegime(volumes, 120); // 1.2x
    assert('1.2x average -> rejected (chop)', low.isHighVolume === false, JSON.stringify(low));
}
{
    const exactly = checkVolumeRegime(Array(20).fill(100), 150); // exactly 1.5x
    assert('exactly 1.5x -> accepted (>=)', exactly.isHighVolume === true, JSON.stringify(exactly));
}
{
    const r = checkVolumeRegime([1, 2, 3], 10);
    assert('insufficient volume data guarded', r.isHighVolume === false && r.reason === 'Insufficient volume data', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// MODULE 3: Trailing stop ratchet
// ---------------------------------------------------------------------------
console.log('\n[3] computeTrailingStop (ratchet up, never down)');
const cfg = { ACTIVATION_PROFIT_PERCENT: 1.0, TRAIL_DISTANCE_PERCENT: 0.5 };
{
    // Not enough profit (+0.5%) -> no trail.
    const r = computeTrailingStop(100, 100.5, 95, cfg);
    assert('below activation threshold -> null', r === null, `got ${r}`);
}
{
    // +2% profit, price 102, trail 0.5% -> new SL 101.49, above old 95 -> move up.
    const r = computeTrailingStop(100, 102, 95, cfg);
    assert('in profit -> new SL = 101.49', approx(r, 101.49), `got ${r}`);
}
{
    // New computed SL (101.49) is LOWER than existing 101.80 -> never move down.
    const r = computeTrailingStop(100, 102, 101.8, cfg);
    assert('never ratchets down -> null', r === null, `got ${r}`);
}
{
    // Big move: +10%, price 110, trail 0.5% -> 109.45.
    const r = computeTrailingStop(100, 110, 101, cfg);
    assert('large move -> SL = 109.45', approx(r, 109.45), `got ${r}`);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);

// scripts/testExchangeManager.js
// Phase B proof-of-work: offline unit tests for the hardened exchange layer.
// Exercises the PURE logic (fee aggregation, partial-fill math, error
// translation, rate-limiter timing) with mocked data — no live Binance needed.
//
// Run with:  node scripts/testExchangeManager.js
// Exit code 0 = all passed, 1 = failure.

const em = require('../exchangeManager');

let passed = 0;
let failed = 0;
function assert(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.error(`  \u2717 ${name}  ${detail}`); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('=== PHASE B: Exchange Manager unit tests ===\n');

// ---------------------------------------------------------------------------
// MODULE 5: Fee calc / fill aggregation — multiple fills, weighted avg price
// ---------------------------------------------------------------------------
console.log('[5] processFilledOrder — weighted average + fee aggregation');
{
    const order = {
        orderId: 101,
        status: 'FILLED',
        origQty: '1.0',
        fills: [
            { qty: '0.5', price: '65000', commission: '0.03', commissionAsset: 'USDT' },
            { qty: '0.5', price: '65200', commission: '0.03', commissionAsset: 'USDT' },
        ],
    };
    const r = em.processFilledOrder(order);
    assert('filledQty sums fills', approx(r.filledQty, 1.0), `got ${r.filledQty}`);
    assert('avgPrice is weighted (65100)', approx(r.avgPrice, 65100), `got ${r.avgPrice}`);
    assert('commission summed (0.06)', approx(r.commission, 0.06), `got ${r.commission}`);
    assert('commissionAsset captured', r.commissionAsset === 'USDT', r.commissionAsset);
}
{
    // Polled getOrder result with NO fills[] — must fall back to totals.
    const order = {
        orderId: 102, status: 'FILLED', origQty: '2.0',
        executedQty: '2.0', cummulativeQuoteQty: '130400', fills: undefined,
    };
    const r = em.processFilledOrder(order);
    assert('fallback avgPrice from cummulativeQuoteQty (65200)', approx(r.avgPrice, 65200), `got ${r.avgPrice}`);
    assert('fallback filledQty from executedQty', approx(r.filledQty, 2.0), `got ${r.filledQty}`);
}
{
    // Nothing filled — must not divide by zero.
    const r = em.processFilledOrder({ orderId: 103, status: 'NEW', origQty: '1', executedQty: '0', cummulativeQuoteQty: '0', fills: [] });
    assert('zero fill -> avgPrice 0, no NaN', r.avgPrice === 0 && Number.isFinite(r.avgPrice), JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// MODULE 3: Partial fill handler
// ---------------------------------------------------------------------------
console.log('\n[3] processPartialFill — remaining qty');
{
    const order = {
        orderId: 201, status: 'CANCELED', origQty: '1.0',
        fills: [{ qty: '0.4', price: '65000', commission: '0.02', commissionAsset: 'USDT' }],
    };
    const r = em.processPartialFill(order);
    assert('status forced PARTIALLY_FILLED', r.status === 'PARTIALLY_FILLED', r.status);
    assert('filledQty = 0.4', approx(r.filledQty, 0.4), `got ${r.filledQty}`);
    assert('remainingQty = 0.6', approx(r.remainingQty, 0.6), `got ${r.remainingQty}`);
}

// ---------------------------------------------------------------------------
// MODULE 4: Error translation
// ---------------------------------------------------------------------------
console.log('\n[4] handleBinanceError — human-readable translation');
function expectThrow(prefix, errObj) {
    try { em.handleBinanceError(errObj); return false; }
    catch (e) { return e.message.startsWith(prefix); }
}
assert('-2010 -> INSUFFICIENT_BALANCE', expectThrow('INSUFFICIENT_BALANCE', { code: -2010, msg: 'Account has insufficient balance' }));
assert('-2019 -> INSUFFICIENT_BALANCE', expectThrow('INSUFFICIENT_BALANCE', { code: -2019, msg: 'Margin is insufficient' }));
assert('-1013 -> INVALID_QUANTITY', expectThrow('INVALID_QUANTITY', { code: -1013, msg: 'Filter failure: LOT_SIZE' }));
assert('-1111 -> INVALID_QUANTITY', expectThrow('INVALID_QUANTITY', { code: -1111, msg: 'Precision over max' }));
assert('-1003 -> RATE_LIMIT_EXCEEDED', expectThrow('RATE_LIMIT_EXCEEDED', { code: -1003, msg: 'Too many requests' }));
assert('-2011 -> UNKNOWN_ORDER', expectThrow('UNKNOWN_ORDER', { code: -2011, msg: 'Unknown order sent' }));
{
    // Unknown code must be re-thrown unchanged.
    const original = { code: -9999, msg: 'some new error' };
    let rethrown = null;
    try { em.handleBinanceError(original); } catch (e) { rethrown = e; }
    assert('unknown code re-thrown unchanged', rethrown === original, String(rethrown && rethrown.msg));
}

// ---------------------------------------------------------------------------
// MODULE 1: Rate limiter — blocks the (N+1)th request within the window
// ---------------------------------------------------------------------------
console.log('\n[1] RateLimiter — enforces window');
(async () => {
    const rl = new em.RateLimiter(3, 500); // 3 per 500ms
    const t0 = Date.now();
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    const beforeBlock = Date.now() - t0;
    assert('first 3 acquisitions are instant', beforeBlock < 100, `took ${beforeBlock}ms`);

    await rl.acquire(); // 4th must wait until the window frees (~500ms)
    const afterBlock = Date.now() - t0;
    assert('4th acquisition waited for window', afterBlock >= 450, `took ${afterBlock}ms`);

    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
})();

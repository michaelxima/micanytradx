// scripts/testInfrastructureManager.js
// Phase C proof-of-work: offline unit tests for the resilience layer.
// Tests the logic that does NOT need a live network or DB:
//   - exponential-backoff delay progression
//   - isClosing suppresses auto-reconnect
//   - overlapping-reconnect guard (single scheduled timer)
//   - heartbeat timer lifecycle (start/stop)
//
// We stub the WebSocket by overriding connect() so no real socket opens.
//
// Run with:  node scripts/testInfrastructureManager.js
// Exit code 0 = all passed, 1 = failure.

const { ResilientWebSocket } = require('../infrastructureManager');

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.error(`  \u2717 ${name}  ${detail}`); }
}

console.log('=== PHASE C: Infrastructure Manager unit tests ===\n');

// ---------------------------------------------------------------------------
// MODULE 1: Exponential backoff delay progression
// ---------------------------------------------------------------------------
console.log('[1] exponential backoff delays');
{
    // Stub connect so reconnect() schedules but never opens a socket.
    const rws = new ResilientWebSocket('btcusdt', '15m', () => {}, null, { maxReconnectDelay: 60000 });
    const scheduled = [];
    rws.connect = () => {}; // no-op stub

    // Capture the delays reconnect() computes by stubbing setTimeout.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => { scheduled.push(delay); return realSetTimeout(() => {}, 0); };

    rws.reconnect(); // attempt 1 -> 1000 * 2^0 = 1000
    rws.reconnectTimer = null;
    rws.reconnect(); // attempt 2 -> 2000
    rws.reconnectTimer = null;
    rws.reconnect(); // attempt 3 -> 4000
    rws.reconnectTimer = null;
    rws.reconnect(); // attempt 4 -> 8000

    global.setTimeout = realSetTimeout;

    assert('attempt 1 delay = 1000ms', scheduled[0] === 1000, `got ${scheduled[0]}`);
    assert('attempt 2 delay = 2000ms', scheduled[1] === 2000, `got ${scheduled[1]}`);
    assert('attempt 3 delay = 4000ms', scheduled[2] === 4000, `got ${scheduled[2]}`);
    assert('attempt 4 delay = 8000ms', scheduled[3] === 8000, `got ${scheduled[3]}`);
}
{
    // Backoff must cap at maxReconnectDelay.
    const rws = new ResilientWebSocket('btcusdt', '15m', () => {}, null, { maxReconnectDelay: 60000 });
    rws.connect = () => {};
    const scheduled = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => { scheduled.push(delay); return realSetTimeout(() => {}, 0); };
    rws.reconnectAttempts = 20; // 2^20 * 1000 is huge
    rws.reconnect();
    global.setTimeout = realSetTimeout;
    assert('delay capped at maxReconnectDelay (60000)', scheduled[0] === 60000, `got ${scheduled[0]}`);
}

// ---------------------------------------------------------------------------
// isClosing suppresses auto-reconnect
// ---------------------------------------------------------------------------
console.log('\n[guard] isClosing suppresses reconnect');
{
    const rws = new ResilientWebSocket('btcusdt', '15m', () => {}, null);
    rws.connect = () => { throw new Error('connect must NOT be called after close()'); };
    rws.close();           // sets isClosing = true
    rws.reconnect();       // should be a no-op
    assert('reconnect() after close() does nothing', rws.reconnectTimer === null);
    assert('isClosing flag set by close()', rws.isClosing === true);
}

// ---------------------------------------------------------------------------
// Overlapping-reconnect guard: only one timer scheduled at a time
// ---------------------------------------------------------------------------
console.log('\n[guard] single scheduled reconnect timer');
{
    const rws = new ResilientWebSocket('btcusdt', '15m', () => {}, null);
    rws.connect = () => {};
    let timers = 0;
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, delay) => { timers++; return realSetTimeout(() => {}, 0); };
    rws.reconnect();  // schedules one
    rws.reconnect();  // guarded — reconnectTimer already set, must NOT schedule again
    global.setTimeout = realSetTimeout;
    assert('second reconnect() does not double-schedule', timers === 1, `scheduled ${timers}`);
}

// ---------------------------------------------------------------------------
// Heartbeat timer lifecycle
// ---------------------------------------------------------------------------
console.log('\n[3] heartbeat start/stop lifecycle');
{
    const rws = new ResilientWebSocket('btcusdt', '15m', () => {}, null, { heartbeatCheckMs: 10000 });
    rws.startHeartbeat();
    assert('startHeartbeat sets interval', rws.heartbeatInterval !== null);
    rws.stopHeartbeat();
    assert('stopHeartbeat clears interval', rws.heartbeatInterval === null);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);

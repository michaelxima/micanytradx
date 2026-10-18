// scripts/testNotificationManager.js
// Phase G proof-of-work: offline unit tests for the notification manager.
// Mocks global.fetch so no real Telegram/Discord calls are made, then asserts
// queueing, content, severity colors, HTML escaping, and disabled channels.
//
// Run with:  node scripts/testNotificationManager.js
// Exit code 0 = all passed, 1 = failure.

// Mock fetch BEFORE requiring the module.
const fetchCalls = [];
global.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
    };
};

// Fake env so both channels are enabled.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = '12345';
process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';

delete require.cache[require.resolve('../notificationManager')];
const nm = require('../notificationManager');

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  \u2713 ${name}`); }
    else { failed++; console.error(`  \u2717 ${name}  ${detail}`); }
}

console.log('=== PHASE G: Notification Manager unit tests ===\n');

(async () => {
    // [1] Module surface
    console.log('[1] module surface');
    for (const fn of ['notify','notifySignal','notifyTradeExecuted','notifyTradeClosed','notifyRiskHalt','notifyTrailingStop','notifyInfrastructure']) {
        assert(`exports ${fn}`, typeof nm[fn] === 'function');
    }

    // [2] notifySignal queues both Telegram + Discord
    console.log('\n[2] notifySignal queues both channels');
    nm._resetForTesting();
    fetchCalls.length = 0;
    nm.notifySignal('BTCUSDT', 'BUY', 65000, 58.5);
    await new Promise((r) => setTimeout(r, 2500));
    assert('both channels called (2 fetches)', fetchCalls.length === 2, `got ${fetchCalls.length}`);
    const tgCall = fetchCalls.find((c) => c.url.includes('telegram'));
    const dcCall = fetchCalls.find((c) => c.url.includes('discord'));
    assert('Telegram call made', !!tgCall);
    assert('Discord call made', !!dcCall);
    if (tgCall) {
        const tgBody = JSON.parse(tgCall.options.body);
        assert('Telegram text has "BUY Signal"', tgBody.text.includes('BUY Signal'));
        assert('Telegram text has symbol', tgBody.text.includes('BTCUSDT'));
    }
    if (dcCall) {
        const dcBody = JSON.parse(dcCall.options.body);
        assert('Discord embed title correct', dcBody.embeds[0].title === 'ℹ️ BUY Signal Generated', dcBody.embeds[0].title);
    }

    // [3] notifyRiskHalt uses critical level (red + 🚨)
    console.log('\n[3] notifyRiskHalt uses critical level');
    nm._resetForTesting();
    fetchCalls.length = 0;
    nm.notifyRiskHalt('Daily loss limit exceeded');
    await new Promise((r) => setTimeout(r, 2500));
    const dcCritical = JSON.parse(fetchCalls.find((c) => c.url.includes('discord')).options.body);
    assert('critical color = red (0xe74c3c)', dcCritical.embeds[0].color === 0xe74c3c, String(dcCritical.embeds[0].color));
    assert('critical emoji present', dcCritical.embeds[0].title.includes('🚨'));

    // [4] HTML escaping prevents injection
    console.log('\n[4] HTML escaping');
    nm._resetForTesting();
    fetchCalls.length = 0;
    nm.notify('info', '<script>alert(1)</script>', 'safe & sound');
    await new Promise((r) => setTimeout(r, 2500));
    const tgEscaped = JSON.parse(fetchCalls.find((c) => c.url.includes('telegram')).options.body);
    assert('script tag escaped out', !tgEscaped.text.includes('<script>'));
    assert('escaped as &lt;script&gt;', tgEscaped.text.includes('&lt;script&gt;'));
    assert('ampersand escaped', tgEscaped.text.includes('safe &amp; sound'));

    // [5] Disabled channel returns sent=false
    console.log('\n[5] disabled channels');
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete require.cache[require.resolve('../notificationManager')];
    const nmDisabled = require('../notificationManager');
    nmDisabled._resetForTesting();
    fetchCalls.length = 0;
    const result = await nmDisabled.sendTelegram('test');
    assert('disabled telegram -> sent=false', result.sent === false);
    assert('disabled telegram -> reason "disabled"', result.reason === 'disabled');

    console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
})();

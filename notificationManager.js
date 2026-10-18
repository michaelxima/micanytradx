// notificationManager.js
// Phase G: multi-channel alerting (Telegram + Discord) with a rate-limited,
// fire-and-forget queue so notifications never block the trading path.
require('dotenv').config();

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    telegram: {
        enabled: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
        token: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
        apiUrl: 'https://api.telegram.org/bot',
    },
    discord: {
        enabled: !!process.env.DISCORD_WEBHOOK_URL,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    },
    notifyOn: {
        signal: process.env.NOTIFY_ON_SIGNAL !== 'false',
        tradeExecuted: process.env.NOTIFY_ON_TRADE !== 'false',
        tradeClosed: process.env.NOTIFY_ON_TRADE !== 'false',
        riskHalt: true, // always notify on kill switch
        trailingStop: process.env.NOTIFY_ON_TRAILING !== 'false',
        infrastructure: true, // always notify on WS issues
    },
    minIntervalMs: 1100, // Telegram allows ~1 msg/sec to the same chat
};

let lastSentAt = 0;
let queue = [];
let isProcessing = false;

// ==========================================
// MODULE 1: Telegram sender
// ==========================================
async function sendTelegram(text, parseMode = 'HTML') {
    if (!CONFIG.telegram.enabled) return { sent: false, reason: 'disabled' };

    const url = `${CONFIG.telegram.apiUrl}${CONFIG.telegram.token}/sendMessage`;
    const payload = {
        chat_id: CONFIG.telegram.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
    };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.ok) {
            console.warn(`⚠️ Telegram API error: ${data.description}`);
            return { sent: false, reason: data.description };
        }
        return { sent: true };
    } catch (err) {
        console.warn(`⚠️ Telegram send failed: ${err.message}`);
        return { sent: false, reason: err.message };
    }
}

// ==========================================
// MODULE 2: Discord sender (rich embeds)
// ==========================================
async function sendDiscord(title, description, color = 0x3498db, fields = []) {
    if (!CONFIG.discord.enabled) return { sent: false, reason: 'disabled' };

    const payload = {
        embeds: [{
            title,
            description,
            color,
            fields,
            timestamp: new Date().toISOString(),
            footer: { text: 'MicanyTradx Engine' },
        }],
    };

    try {
        const res = await fetch(CONFIG.discord.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (res.status === 204 || res.ok) return { sent: true };
        const text = await res.text();
        console.warn(`⚠️ Discord webhook error: ${text}`);
        return { sent: false, reason: text };
    } catch (err) {
        console.warn(`⚠️ Discord send failed: ${err.message}`);
        return { sent: false, reason: err.message };
    }
}

// ==========================================
// MODULE 3: Rate-limited queue
// ==========================================
async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    while (queue.length > 0) {
        const now = Date.now();
        const timeSinceLast = now - lastSentAt;
        if (timeSinceLast < CONFIG.minIntervalMs) {
            await new Promise((r) => setTimeout(r, CONFIG.minIntervalMs - timeSinceLast));
        }
        const item = queue.shift();
        try {
            await item.fn();
        } catch (err) {
            console.warn('⚠️ Notification send threw:', err.message);
        }
        lastSentAt = Date.now();
    }
    isProcessing = false;
}

function enqueue(fn) {
    queue.push({ fn });
    processQueue(); // fire-and-forget
}

// ==========================================
// MODULE 4: High-level notification API
// ==========================================
function notify(level, title, message, fields = {}) {
    const colors = { info: 0x3498db, warning: 0xf39c12, critical: 0xe74c3c };
    const emojis = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };
    const emoji = emojis[level] || 'ℹ️';
    const color = colors[level] || 0x3498db;

    const tgText = `${emoji} <b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`;

    const discordFields = Object.entries(fields).map(([name, value]) => ({
        name: String(name),
        value: String(value),
        inline: true,
    }));

    enqueue(() => sendTelegram(tgText));
    enqueue(() => sendDiscord(`${emoji} ${title}`, message, color, discordFields));
}

// Convenience wrappers
function notifySignal(symbol, side, price, rsi) {
    if (!CONFIG.notifyOn.signal) return;
    notify('info', `${side} Signal Generated`, `${symbol} @ $${price}`, {
        Side: side, Price: `$${price}`, RSI: (rsi != null ? Number(rsi).toFixed(2) : 'N/A'),
    });
}

function notifyTradeExecuted(symbol, side, qty, entryPrice) {
    if (!CONFIG.notifyOn.tradeExecuted) return;
    notify('info', `Trade Executed: ${side}`, `${symbol} | Qty: ${qty} @ $${entryPrice}`, {
        Symbol: symbol, Side: side, Quantity: qty, Entry: `$${entryPrice}`,
    });
}

function notifyTradeClosed(symbol, pnl, pnlPercent, reason) {
    if (!CONFIG.notifyOn.tradeClosed) return;
    const level = parseFloat(pnl) >= 0 ? 'info' : 'warning';
    notify(level, `Trade Closed: ${symbol}`, `P&L: ${pnl} USDT (${pnlPercent}%)`, {
        Symbol: symbol, PnL: `${pnl} USDT`, 'PnL %': `${pnlPercent}%`, Reason: reason,
    });
}

function notifyRiskHalt(reason) {
    if (!CONFIG.notifyOn.riskHalt) return;
    notify('critical', 'TRADING HALTED', `Risk manager stopped all trading: ${reason}`, {
        Reason: reason, Action: 'Manual reset required',
    });
}

function notifyTrailingStop(symbol, oldSl, newSl, profitPercent) {
    if (!CONFIG.notifyOn.trailingStop) return;
    notify('info', `Trailing Stop Moved: ${symbol}`, `SL: $${oldSl} → $${newSl}`, {
        Symbol: symbol, 'Old SL': `$${oldSl}`, 'New SL': `$${newSl}`, Profit: `${profitPercent}%`,
    });
}

function notifyInfrastructure(event, details) {
    if (!CONFIG.notifyOn.infrastructure) return;
    notify('warning', `Infrastructure: ${event}`, details || '');
}

// ==========================================
// HELPERS
// ==========================================
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _resetForTesting() {
    queue = [];
    isProcessing = false;
    lastSentAt = 0;
}

module.exports = {
    notify,
    notifySignal,
    notifyTradeExecuted,
    notifyTradeClosed,
    notifyRiskHalt,
    notifyTrailingStop,
    notifyInfrastructure,
    sendTelegram,
    sendDiscord,
    _resetForTesting,
    _getQueue: () => queue,
};

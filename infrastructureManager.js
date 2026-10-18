// infrastructureManager.js
// Phase C: Infrastructure resilience. Keeps the bot running and capital safe
// when the WebSocket drops, the process restarts, the stream goes "zombie",
// or the host sends a termination signal.
//
//   Module 1  ResilientWebSocket  — exponential-backoff auto-reconnect
//   Module 2  recoverOpenPositions — re-sync open trades from DB on boot
//   Module 3  Heartbeat            — detect connected-but-silent "zombie" sockets
//   Module 4  gracefulShutdown     — clean up on SIGINT/SIGTERM
require('dotenv').config();
const WebSocket = require('ws');
const pool = require('./db');
const { client: binanceClient } = require('./exchangeManager');
const { notifyInfrastructure } = require('./notificationManager');

// ==========================================
// MODULES 1 & 3: Resilient WebSocket Manager (auto-reconnect + heartbeat)
// ==========================================
class ResilientWebSocket {
    constructor(symbol, timeframe, onMessage, onReconnect, options = {}) {
        this.symbol = symbol;
        this.timeframe = timeframe;
        this.onMessage = onMessage;
        this.onReconnect = onReconnect;

        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = options.maxReconnectDelay || 60000; // cap at 60s
        this.heartbeatCheckMs = options.heartbeatCheckMs || 15000;    // check every 15s
        this.heartbeatTimeoutMs = options.heartbeatTimeoutMs || 45000; // 45s silence = dead
        this.heartbeatInterval = null;
        this.lastMessageTime = Date.now();

        this.isClosing = false;      // set by close(): suppresses auto-reconnect
        this.reconnectTimer = null;  // guards against overlapping reconnect timers
    }

    connect() {
        const wsUrl = `wss://stream.binance.com:9443/ws/${this.symbol.toLowerCase()}@kline_${this.timeframe}`;
        console.log(`\ud83d\udd0c Connecting to WebSocket: ${wsUrl}`);

        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            console.log(`\u2705 WebSocket connected to ${this.symbol} ${this.timeframe}`);
            this.reconnectAttempts = 0; // reset backoff on a healthy connection
            this.lastMessageTime = Date.now();
            this.startHeartbeat();
        });

        this.ws.on('message', (data) => {
            this.lastMessageTime = Date.now(); // feed the heartbeat
            try {
                this.onMessage(JSON.parse(data.toString()));
            } catch (err) {
                console.error('\u274c Error parsing WebSocket message:', err.message);
            }
        });

        this.ws.on('error', (err) => {
            console.error(`\u274c WebSocket error for ${this.symbol}:`, err.message);
            // Do NOT reconnect here — 'error' is followed by 'close', which
            // owns reconnection. Reconnecting in both races two sockets.
        });

        this.ws.on('close', () => {
            this.stopHeartbeat();
            if (this.isClosing) {
                console.log(`\ud83d\udd0c WebSocket closed cleanly for ${this.symbol}.`);
                return;
            }
            console.warn(`\u26a0\ufe0f WebSocket closed for ${this.symbol}. Attempting reconnect...`);
            this.reconnect();
        });
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            const silence = Date.now() - this.lastMessageTime;
            if (silence > this.heartbeatTimeoutMs) {
                console.error(
                    `\ud83d\udea8 HEARTBEAT FAILED: no data for ${silence}ms. Forcing reconnect.`
                );
                notifyInfrastructure('Heartbeat Failed', `${this.symbol} silent for ${silence}ms`);
                this.stopHeartbeat();
                // terminate() fires 'close', which triggers reconnect once.
                try { this.ws.terminate(); } catch { /* already dead */ }
            }
        }, this.heartbeatCheckMs);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    reconnect() {
        if (this.isClosing) return;
        if (this.reconnectTimer) return; // a reconnect is already scheduled

        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.maxReconnectDelay);
        this.reconnectAttempts++;
        console.log(`\u23f3 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        // Phase G: alert on first reconnect and every 5th, to avoid spam.
        if (this.reconnectAttempts === 1 || this.reconnectAttempts % 5 === 0) {
            notifyInfrastructure(
                'WebSocket Reconnect',
                `${this.symbol} reconnecting (attempt ${this.reconnectAttempts})`
            );
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.onReconnect) {
                try { this.onReconnect(); } catch (e) { console.error('onReconnect error:', e.message); }
            }
            this.connect();
        }, delay);
    }

    close() {
        this.isClosing = true;
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
        }
    }
}

// ==========================================
// MODULE 2: State Recovery on Restart
// ==========================================
// On boot, re-read every OPEN trade so the engine knows what it must keep
// watching for stop-loss / exit. Returns the rows so the caller can re-arm
// monitoring. (Exchange-side order matching is a later enhancement.)
async function recoverOpenPositions() {
    console.log('\ud83d\udd04 Recovering state: checking for open positions...');
    try {
        const result = await pool.query(
            `SELECT id, symbol, quantity, entry_price, stop_loss_price
             FROM trades WHERE status = 'OPEN'`
        );

        if (result.rows.length === 0) {
            console.log('\u2705 No open positions to recover.');
            return [];
        }

        console.log(`\u26a0\ufe0f Found ${result.rows.length} open position(s). Re-syncing...`);
        for (const trade of result.rows) {
            console.log(
                `\ud83d\udccc Recovered: ${trade.symbol} | Qty: ${trade.quantity} | ` +
                `Entry: ${trade.entry_price} | SL: ${trade.stop_loss_price}`
            );
        }
        return result.rows;
    } catch (error) {
        console.error('\u274c Failed to recover open positions:', error.message);
        return [];
    }
}

// ==========================================
// MODULE 4: Graceful Shutdown
// ==========================================
// Registers SIGINT/SIGTERM handlers ONCE. Accepts optional hooks so the
// caller can inject the live WS manager and risk-halt without creating a
// circular require. Idempotent — a second signal won't double-run cleanup.
let shuttingDown = false;

function registerGracefulShutdown({ wsManager, onHalt, onStop } = {}) {
    async function gracefulShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n\ud83d\uded1 Received ${signal}. Initiating graceful shutdown...`);

        try {
            // 1. Stop accepting new trades.
            console.log('1. Halting new trade signals...');
            if (typeof onHalt === 'function') {
                try { onHalt('Graceful shutdown'); } catch (e) { console.error('   halt hook error:', e.message); }
            }

            // 1b. Stop background loops (e.g. trailing-stop manager).
            if (typeof onStop === 'function') {
                try { await onStop(); } catch (e) { console.error('   stop hook error:', e.message); }
            }

            // 2. Close WebSocket connections.
            console.log('2. Closing WebSocket connections...');
            if (wsManager && typeof wsManager.close === 'function') {
                try { wsManager.close(); } catch (e) { console.error('   ws close error:', e.message); }
            } else if (global.wsManager && typeof global.wsManager.close === 'function') {
                try { global.wsManager.close(); } catch (e) { console.error('   ws close error:', e.message); }
            }

            // 3. Close the database pool.
            console.log('3. Closing database connection pool...');
            try { await pool.end(); } catch (e) { console.error('   pool end error:', e.message); }

            console.log('\u2705 Graceful shutdown complete. Exiting.');
        } finally {
            process.exit(0);
        }
    }

    process.once('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM')); // host termination
    return gracefulShutdown;
}

module.exports = {
    ResilientWebSocket,
    recoverOpenPositions,
    registerGracefulShutdown,
    binanceClient,
};

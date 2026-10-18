// strategyEngine.js

require('dotenv').config();
const WebSocket = require('ws');
const { EMA, RSI } = require('technicalindicators');
const Binance = require('binance-api-node').default;
const { ResilientWebSocket, recoverOpenPositions } = require('./infrastructureManager');
const { checkHigherTimeframeTrend, checkVolumeRegime } = require('./marketAnalyzer');

// ---------------------------------------------------------------------------
// Binance API client (testnet or live depending on .env)
// ---------------------------------------------------------------------------
const binanceClient = Binance({
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    ...(process.env.BINANCE_TESTNET === 'true' && {
        httpBase: 'https://testnet.binance.vision',
        wsBase: 'wss://testnet.binance.vision/ws',
    }),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SYMBOL = (process.env.SYMBOL || 'btcusdt').toLowerCase();
const TIMEFRAME = process.env.TIMEFRAME || '15m'; // 15-minute candles
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const RSI_PERIOD = 14;

const MAX_HISTORY = 100;          // how many closes we retain
const STOP_LOSS_PCT = 0.025;      // 2.5% hard stop
const RSI_BUY_CEILING = 65;       // don't buy above this RSI

// Minimum data points before we trust the indicators.
// EMA is recursive and needs warm-up; RSI needs RSI_PERIOD+1 points.
// Requiring slow EMA + RSI period gives both room plus a prior value
// for crossover detection.
const MIN_POINTS = EMA_SLOW_PERIOD + RSI_PERIOD; // 35

// ---------------------------------------------------------------------------
// State management (In production, this goes to PostgreSQL)
// ---------------------------------------------------------------------------
let closePrices = [];
let currentPrice = 0;
let isInPosition = false; // Toggles when you confirm a buy
let entryPrice = 0;       // Real price captured at buy confirmation

// ---------------------------------------------------------------------------
// WebSocket connection with auto-reconnect
// ---------------------------------------------------------------------------
// Phase C: resilient WebSocket (auto-reconnect + heartbeat) replaces the old
// hand-rolled socket. The candle-processing logic is unchanged — it just
// lives in the onMessage callback now.
let wsManager = null;

function handleKline(message) {
    const kline = message.k;
    if (!kline) return;

    // Only evaluate when a candle CLOSES (x: true) to avoid mid-candle noise.
    if (kline.x) {
        const closePrice = parseFloat(kline.c);
        if (!Number.isFinite(closePrice)) return;

        closePrices.push(closePrice);
        currentPrice = closePrice;

        if (closePrices.length > MAX_HISTORY) {
            closePrices.shift();
        }

        console.log(
            `[Candle Closed] Price: $${closePrice} | Array Length: ${closePrices.length}`
        );
        evaluateStrategy();
    }
}

function connect() {
    if (wsManager) return wsManager; // already connected / connecting

    // Module 2: recover any OPEN positions from the DB before we start, so a
    // restart never drops stop-loss monitoring. Non-fatal if the DB is down.
    recoverOpenPositions()
        .then((openTrades) => {
            if (openTrades && openTrades.length > 0) {
                // Re-arm in-memory state from the most recent open position so
                // the SELL / stop-loss evaluation resumes after a restart.
                const latest = openTrades[0];
                isInPosition = true;
                entryPrice = parseFloat(latest.entry_price) || 0;
                console.log(`\ud83d\udd01 Re-armed monitoring: in position @ ${entryPrice}`);
            }
        })
        .catch((err) => console.error('State recovery error:', err.message))
        .finally(() => {
            wsManager = new ResilientWebSocket(
                SYMBOL,
                TIMEFRAME,
                handleKline,
                () => console.log('\ud83d\udd04 WebSocket reconnected. Resuming strategy evaluation.')
            );
            wsManager.connect();
            global.wsManager = wsManager; // exposed for graceful shutdown
        });

    return wsManager;
}

function getWsManager() {
    return wsManager;
}

// ---------------------------------------------------------------------------
// Strategy evaluation
// ---------------------------------------------------------------------------
function evaluateStrategy() {
    if (closePrices.length < MIN_POINTS) {
        console.log(`Accumulating data... (${closePrices.length}/${MIN_POINTS})`);
        return;
    }

    // 1. Calculate Indicators
    const emaFast = EMA.calculate({ values: closePrices, period: EMA_FAST_PERIOD });
    const emaSlow = EMA.calculate({ values: closePrices, period: EMA_SLOW_PERIOD });
    const rsi = RSI.calculate({ values: closePrices, period: RSI_PERIOD });

    const currentEmaFast = emaFast[emaFast.length - 1];
    const currentEmaSlow = emaSlow[emaSlow.length - 1];
    const previousEmaFast = emaFast[emaFast.length - 2];
    const previousEmaSlow = emaSlow[emaSlow.length - 2];
    const currentRsi = rsi[rsi.length - 1];

    // Guard against undefined values (prevents .toFixed crashes).
    if (
        currentEmaFast === undefined ||
        currentEmaSlow === undefined ||
        previousEmaFast === undefined ||
        previousEmaSlow === undefined ||
        currentRsi === undefined
    ) {
        console.log('Indicators not ready yet...');
        return;
    }

    console.log(
        `[Indicators] EMA9: ${currentEmaFast.toFixed(2)} | ` +
        `EMA21: ${currentEmaSlow.toFixed(2)} | RSI: ${currentRsi.toFixed(2)}`
    );

    // 2. Evaluate BUY Conditions
    if (!isInPosition) {
        const isBullishCross =
            previousEmaFast <= previousEmaSlow && currentEmaFast > currentEmaSlow;
        const isRsiHealthy = currentRsi < RSI_BUY_CEILING;

        if (isBullishCross && isRsiHealthy) {
            // --- Phase E: advanced-logic confirmation filters ---
            // Degrade gracefully: if 1h or volume series aren't tracked yet,
            // the checks return false with a reason rather than throwing.
            const mtfCheck = checkHigherTimeframeTrend(global.closePrices1h || closePrices);
            const volumes = global.volumes || [];
            const currentVolume = volumes.length ? volumes[volumes.length - 1] : 0;
            const volumeCheck = checkVolumeRegime(volumes, currentVolume);

            if (mtfCheck.isBullishHigherTrend && volumeCheck.isHighVolume) {
                console.log(`🚨 HIGH-CONFIDENCE BUY SIGNAL 🚨`);
                console.log(
                    `Asset: ${SYMBOL.toUpperCase()} | Price: $${currentPrice} | ` +
                    `RSI: ${currentRsi.toFixed(2)}`
                );
                console.log(`   ✅ 15m EMA cross + RSI < ${RSI_BUY_CEILING}`);
                console.log(`   ✅ 1h trend bullish (price > 1h EMA50)`);
                console.log(`   ✅ Volume spike: ${volumeCheck.volumeRatio}x average`);
                // TODO: Trigger Push Notification / Webhook to your Next.js frontend here
                // TODO: Log signal to PostgreSQL
                // The human reviews the alert and calls confirmBuy() to enter.
            } else {
                console.log(
                    `⚠️ Signal rejected by advanced logic: ` +
                    `MTF=${mtfCheck.isBullishHigherTrend} (${mtfCheck.reason || 'ok'}), ` +
                    `Volume=${volumeCheck.isHighVolume} (${volumeCheck.reason || volumeCheck.volumeRatio + 'x'})`
                );
            }
        }
    }
    // 3. Evaluate SELL Conditions (If we are in a position)
    else {
        const isBearishCross =
            previousEmaFast >= previousEmaSlow && currentEmaFast < currentEmaSlow;
        const stopLossHit = currentPrice <= entryPrice * (1 - STOP_LOSS_PCT);

        if (isBearishCross || stopLossHit) {
            const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
            console.log(`🚨 SELL SIGNAL GENERATED 🚨`);
            console.log(
                `Reason: ${isBearishCross ? 'Trend Reversal' : 'Stop Loss Hit'} | ` +
                `Entry: $${entryPrice} | Current: $${currentPrice} | ` +
                `P&L: ${pnlPct.toFixed(2)}%`
            );
            // TODO: Trigger Push Notification / Webhook to your Next.js frontend here
            // TODO: Update PostgreSQL trade record to 'CLOSED'
            isInPosition = false; // Reset state
            entryPrice = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Human-in-the-loop hooks
// Call these from your API layer when the user confirms an action.
// ---------------------------------------------------------------------------
function confirmBuy(price = currentPrice) {
    if (isInPosition) {
        console.warn('Already in a position — ignoring confirmBuy.');
        return false;
    }
    isInPosition = true;
    entryPrice = price;
    console.log(`✅ Position opened at $${entryPrice}`);
    // DB write is handled by tradeController.confirmBuy, which calls this
    // after the transaction commits. Keep this purely in-memory.
    return true;
}

function confirmSell(price = currentPrice) {
    if (!isInPosition) {
        console.warn('Not in a position — ignoring confirmSell.');
        return false;
    }
    const pnlPct = ((price - entryPrice) / entryPrice) * 100;
    console.log(`✅ Position closed at $${price} | P&L: ${pnlPct.toFixed(2)}%`);
    isInPosition = false;
    entryPrice = 0;
    // DB write is handled by tradeController.confirmSell.
    return true;
}

// Expose read access to engine state so controllers can inspect it.
function getState() {
    return { isInPosition, entryPrice, currentPrice };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
if (require.main === module) {
    connect();
}

module.exports = { confirmBuy, confirmSell, getState, connect, getWsManager, binanceClient };

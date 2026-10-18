// exchangeManager.js
// Phase B: Hardened exchange layer. Every order goes through here so we get
// rate-limit protection, order-status polling, partial-fill handling,
// human-readable error translation, and accurate fee capture.
require('dotenv').config();
const Binance = require('binance-api-node').default;

const isTestnet = process.env.BINANCE_TESTNET === 'true';
const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    httpBase: isTestnet ? 'https://testnet.binance.vision' : 'https://api.binance.com',
    wsBase: isTestnet ? 'wss://testnet.binance.vision/ws' : 'wss://stream.binance.com:9443/ws',
});

// ==========================================
// MODULE 1: Rate Limit Management
// ==========================================
// Sliding-window limiter. Binance allows ~1200 request-weights/min; we cap at
// a conservative 10 requests/second so we never get IP-banned.
class RateLimiter {
    constructor(maxRequests, timeWindowMs) {
        this.maxRequests = maxRequests;
        this.timeWindowMs = timeWindowMs;
        this.requests = [];
    }

    async acquire() {
        const now = Date.now();
        // Drop timestamps outside the current window.
        this.requests = this.requests.filter((t) => now - t < this.timeWindowMs);

        if (this.requests.length >= this.maxRequests) {
            const waitTime = this.timeWindowMs - (now - this.requests[0]);
            console.log(`\u23f3 Rate limit reached. Waiting ${waitTime}ms...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            return this.acquire(); // retry after the window frees up
        }
        this.requests.push(now);
    }
}

// 10 requests per 1000ms.
const rateLimiter = new RateLimiter(10, 1000);

// ==========================================
// MODULE 4: Insufficient Balance & Error Recovery
// ==========================================
// Translate cryptic Binance error codes into clean, actionable messages.
function handleBinanceError(error) {
    const code = error && error.code;
    const msg = (error && error.msg) || (error && error.message) || 'Unknown exchange error';

    if (code === -2010 || code === -2019) {
        throw new Error(`INSUFFICIENT_BALANCE: ${msg}`);
    }
    if (code === -1013 || code === -1111) {
        throw new Error(`INVALID_QUANTITY: ${msg} (check lot size / step size)`);
    }
    if (code === -1003) {
        throw new Error(`RATE_LIMIT_EXCEEDED: ${msg}`);
    }
    if (code === -2011) {
        throw new Error(`UNKNOWN_ORDER: ${msg} (already filled or canceled)`);
    }
    throw error; // re-throw anything we don't specifically handle
}

// ==========================================
// MODULE 5: Fee Calculation & Fill Processing
// ==========================================
// Aggregate the fills[] array into a true average price + total commission.
// MARKET orders return fills[]; polled getOrder() responses often do NOT, so
// we fall back to cummulativeQuoteQty / executedQty for the average price.
function processFilledOrder(order) {
    let totalQty = 0;
    let totalQuoteQty = 0;
    let totalCommission = 0;
    let commissionAsset = 'USDT'; // sensible default

    if (Array.isArray(order.fills) && order.fills.length > 0) {
        for (const fill of order.fills) {
            const qty = parseFloat(fill.qty);
            const price = parseFloat(fill.price);
            totalQty += qty;
            totalQuoteQty += qty * price;
            totalCommission += parseFloat(fill.commission || 0);
            if (fill.commissionAsset) commissionAsset = fill.commissionAsset;
        }
    } else {
        // No fills[] (typical for a polled getOrder result). Derive from totals.
        totalQty = parseFloat(order.executedQty || 0);
        totalQuoteQty = parseFloat(
            order.cummulativeQuoteQty != null ? order.cummulativeQuoteQty : 0
        );
    }

    // Guard against divide-by-zero when nothing actually filled.
    const avgPrice = totalQty > 0 ? totalQuoteQty / totalQty : 0;

    return {
        orderId: order.orderId,
        status: order.status,
        filledQty: parseFloat(totalQty.toFixed(8)),
        avgPrice: parseFloat(avgPrice.toFixed(8)),
        commission: parseFloat(totalCommission.toFixed(8)),
        commissionAsset,
        rawFills: order.fills || [],
    };
}

// ==========================================
// MODULE 3: Partial Fill Handler
// ==========================================
function processPartialFill(order) {
    const processed = processFilledOrder(order);
    processed.status = 'PARTIALLY_FILLED';
    processed.remainingQty = parseFloat(
        (parseFloat(order.origQty) - processed.filledQty).toFixed(8)
    );
    return processed;
}

// ==========================================
// MODULE 2: Order Placement + Status Polling
// ==========================================
// Places the order, then (for LIMIT orders) polls until it fills, partially
// fills, is canceled, or times out. On timeout we cancel to avoid orphaned
// orders and still record any partial fill.
async function placeOrderAndWaitForFill(orderParams, timeoutMs = 30000) {
    await rateLimiter.acquire();

    let order;
    try {
        order = await client.order(orderParams);
    } catch (error) {
        handleBinanceError(error);
    }

    // Instant fill (common for MARKET orders).
    if (order.status === 'FILLED') {
        return processFilledOrder(order);
    }

    // LIMIT orders: poll for terminal status.
    if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // poll every 1s
            await rateLimiter.acquire();

            let status;
            try {
                status = await client.getOrder({ symbol: order.symbol, orderId: order.orderId });
            } catch (error) {
                handleBinanceError(error);
            }

            if (status.status === 'FILLED') {
                return processFilledOrder(status);
            }

            if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(status.status)) {
                if (parseFloat(status.executedQty) > 0) {
                    return processPartialFill(status);
                }
                throw new Error(`Order ${status.status} without any fills.`);
            }
        }

        // Timeout: cancel to prevent an orphaned resting order.
        console.warn(`\u26a0\ufe0f Order timeout reached. Canceling order ${order.orderId}...`);
        await cancelOrder(order.symbol, order.orderId);

        await rateLimiter.acquire();
        const finalStatus = await client.getOrder({ symbol: order.symbol, orderId: order.orderId });

        if (parseFloat(finalStatus.executedQty) > 0) {
            return processPartialFill(finalStatus);
        }
        throw new Error('Order timed out, was canceled, and has no fills.');
    }

    // Any other initial status — process what we have.
    return processFilledOrder(order);
}

async function cancelOrder(symbol, orderId) {
    await rateLimiter.acquire();
    try {
        await client.cancelOrder({ symbol, orderId });
    } catch (error) {
        // -2011 = unknown order (already canceled/filled). Safe to ignore.
        if (error.code !== -2011) {
            handleBinanceError(error);
        }
    }
}

module.exports = {
    placeOrderAndWaitForFill,
    cancelOrder,
    processFilledOrder,
    processPartialFill,
    handleBinanceError,
    RateLimiter,
    client,
};

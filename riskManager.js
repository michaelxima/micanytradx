// riskManager.js
// Comprehensive risk management layer. Every trade must pass through
// performRiskCheck() before execution. Covers position sizing, daily kill
// switch, max drawdown, position limits, and minimum balance safeguards.

require('dotenv').config();
const pool = require('./db');

// ---------------------------------------------------------------------------
// Binance REST client (reuse same testnet/live config as tradeController)
// ---------------------------------------------------------------------------
const Binance = require('binance-api-node').default;
const isTestnet = process.env.BINANCE_TESTNET === 'true';
const client = Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    httpBase: isTestnet
        ? 'https://testnet.binance.vision'
        : 'https://api.binance.com',
    wsBase: isTestnet
        ? 'wss://testnet.binance.vision/ws'
        : 'wss://stream.binance.com:9443/ws',
});

// ==========================================
// CONFIGURATION (from environment variables)
// ==========================================
const RISK_CONFIG = {
    // Position Sizing
    RISK_PER_TRADE_PERCENT: parseFloat(process.env.RISK_PER_TRADE_PERCENT) || 2,
    MAX_POSITIONS: parseInt(process.env.MAX_POSITIONS) || 3,

    // Kill Switch
    DAILY_LOSS_LIMIT_PERCENT: parseFloat(process.env.DAILY_LOSS_LIMIT_PERCENT) || 5,
    MAX_DRAWDOWN_PERCENT: parseFloat(process.env.MAX_DRAWDOWN_PERCENT) || 20,

    // Safety
    MINIMUM_BALANCE_USDT: parseFloat(process.env.MINIMUM_BALANCE_USDT) || 100,

    // State (mutable at runtime)
    isTradingHalted: false,
    haltReason: null,
};

// ==========================================
// HELPER: Get current USDT balance from Binance
// ==========================================
async function getAccountBalance() {
    try {
        const accountInfo = await client.accountInfo();
        const usdtBalance = accountInfo.balances.find((b) => b.asset === 'USDT');
        return parseFloat(usdtBalance?.free || 0);
    } catch (error) {
        console.error('Error fetching account balance from Binance:', error.message);
        throw error;
    }
}

// ==========================================
// MODULE 1: Dynamic Position Sizing Engine
// ==========================================
/**
 * Calculates the optimal position size based on account balance and risk.
 * @param {number} accountBalance - Total account balance in USDT
 * @param {number} entryPrice - Planned entry price
 * @param {number} stopLossPrice - Price at which we exit if wrong
 * @returns {{ quantity: number, riskAmount: number, riskPercentage: number, positionValue: number }}
 */
function calculatePositionSize(accountBalance, entryPrice, stopLossPrice) {
    const riskAmount = accountBalance * (RISK_CONFIG.RISK_PER_TRADE_PERCENT / 100);
    const stopLossDistance = Math.abs(entryPrice - stopLossPrice);

    if (stopLossDistance === 0) {
        return { quantity: 0, riskAmount: 0, riskPercentage: 0, positionValue: 0 };
    }

    const quantity = riskAmount / stopLossDistance;
    const actualRiskAmount = quantity * stopLossDistance;
    const actualRiskPercentage = (actualRiskAmount / accountBalance) * 100;

    return {
        quantity: parseFloat(quantity.toFixed(8)),
        riskAmount: parseFloat(actualRiskAmount.toFixed(2)),
        riskPercentage: parseFloat(actualRiskPercentage.toFixed(2)),
        positionValue: parseFloat((quantity * entryPrice).toFixed(2)),
    };
}

// ==========================================
// MODULE 2: Daily Kill Switch
// ==========================================
/**
 * Checks if today's realized P&L has exceeded the daily loss limit.
 * @returns {{ isSafe: boolean, todayPnL: number, limit: number }}
 */
async function checkDailyKillSwitch() {
    try {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        const result = await pool.query(
            `SELECT COALESCE(SUM(pnl_absolute), 0) AS daily_pnl
             FROM trades
             WHERE status = 'CLOSED'
               AND closed_at >= $1`,
            [today]
        );

        const todayPnL = parseFloat(result.rows[0].daily_pnl);
        const accountBalance = await getAccountBalance();
        const dailyLossLimit = accountBalance * (RISK_CONFIG.DAILY_LOSS_LIMIT_PERCENT / 100);

        const isSafe = todayPnL > -dailyLossLimit;

        if (!isSafe) {
            console.error(
                `🚨 KILL SWITCH TRIGGERED: Daily loss of $${Math.abs(todayPnL).toFixed(2)} ` +
                `exceeds limit of $${dailyLossLimit.toFixed(2)}`
            );
            haltTrading(`Daily loss limit exceeded: $${Math.abs(todayPnL).toFixed(2)}`);
        }

        return {
            isSafe,
            todayPnL: parseFloat(todayPnL.toFixed(2)),
            limit: parseFloat(dailyLossLimit.toFixed(2)),
        };
    } catch (error) {
        console.error('Error checking daily kill switch:', error.message);
        return { isSafe: false, todayPnL: 0, limit: 0, error: error.message };
    }
}

// ==========================================
// MODULE 3: Maximum Drawdown Protection
// ==========================================
/**
 * Checks if the account has hit maximum drawdown from peak balance.
 * Uses the account_snapshots table to track peak balance over time.
 * @returns {{ isSafe: boolean, currentBalance: number, peakBalance: number, drawdownPercent: number }}
 */
async function checkMaxDrawdown() {
    try {
        const currentBalance = await getAccountBalance();

        // Record a new snapshot (so peak tracking stays up-to-date)
        await pool.query(
            `INSERT INTO account_snapshots (balance_snapshot) VALUES ($1)`,
            [currentBalance]
        );

        // Get peak balance from all snapshots
        const peakResult = await pool.query(
            `SELECT COALESCE(MAX(balance_snapshot), $1) AS peak_balance
             FROM account_snapshots`,
            [currentBalance]
        );

        const peakBalance = parseFloat(peakResult.rows[0].peak_balance);
        const drawdownAmount = peakBalance - currentBalance;
        const drawdownPercent = peakBalance > 0 ? (drawdownAmount / peakBalance) * 100 : 0;

        const isSafe = drawdownPercent < RISK_CONFIG.MAX_DRAWDOWN_PERCENT;

        if (!isSafe) {
            console.error(
                `🚨 MAX DRAWDOWN TRIGGERED: ${drawdownPercent.toFixed(2)}% drawdown ` +
                `exceeds limit of ${RISK_CONFIG.MAX_DRAWDOWN_PERCENT}%`
            );
            haltTrading(`Maximum drawdown exceeded: ${drawdownPercent.toFixed(2)}%`);
        }

        return {
            isSafe,
            currentBalance: parseFloat(currentBalance.toFixed(2)),
            peakBalance: parseFloat(peakBalance.toFixed(2)),
            drawdownPercent: parseFloat(drawdownPercent.toFixed(2)),
        };
    } catch (error) {
        console.error('Error checking max drawdown:', error.message);
        return { isSafe: false, currentBalance: 0, peakBalance: 0, drawdownPercent: 0, error: error.message };
    }
}

// ==========================================
// MODULE 4: Position Limits
// ==========================================
/**
 * Checks if we've reached the maximum number of concurrent positions.
 * @returns {{ canOpen: boolean, currentPositions: number, maxPositions: number }}
 */
async function checkPositionLimits() {
    try {
        const result = await pool.query(
            `SELECT COUNT(*) AS open_count FROM trades WHERE status = 'OPEN'`
        );

        const currentPositions = parseInt(result.rows[0].open_count);
        const canOpen = currentPositions < RISK_CONFIG.MAX_POSITIONS;

        if (!canOpen) {
            console.warn(
                `⚠️ Position limit reached: ${currentPositions}/${RISK_CONFIG.MAX_POSITIONS} positions open`
            );
        }

        return { canOpen, currentPositions, maxPositions: RISK_CONFIG.MAX_POSITIONS };
    } catch (error) {
        console.error('Error checking position limits:', error.message);
        return { canOpen: false, currentPositions: 0, maxPositions: RISK_CONFIG.MAX_POSITIONS, error: error.message };
    }
}

// ==========================================
// MODULE 5: Minimum Balance Check
// ==========================================
/**
 * Checks if account balance is above minimum threshold.
 * @returns {{ isSafe: boolean, currentBalance: number, minimumBalance: number }}
 */
async function checkMinimumBalance() {
    try {
        const currentBalance = await getAccountBalance();
        const isSafe = currentBalance >= RISK_CONFIG.MINIMUM_BALANCE_USDT;

        if (!isSafe) {
            console.warn(
                `⚠️ Balance too low: $${currentBalance.toFixed(2)} < $${RISK_CONFIG.MINIMUM_BALANCE_USDT}`
            );
        }

        return {
            isSafe,
            currentBalance: parseFloat(currentBalance.toFixed(2)),
            minimumBalance: RISK_CONFIG.MINIMUM_BALANCE_USDT,
        };
    } catch (error) {
        console.error('Error checking minimum balance:', error.message);
        return { isSafe: false, currentBalance: 0, minimumBalance: RISK_CONFIG.MINIMUM_BALANCE_USDT, error: error.message };
    }
}

// ==========================================
// MASTER RISK CHECK (Runs all checks before any trade)
// ==========================================
/**
 * Comprehensive risk check before executing any trade.
 * @param {number} entryPrice
 * @param {number} stopLossPrice
 * @returns {{ canTrade: boolean, reasons: string[], positionSizing: object|null, checks: object }}
 */
async function performRiskCheck(entryPrice, stopLossPrice) {
    console.log('🔍 Performing comprehensive risk check...');

    // Check if trading is already halted
    if (RISK_CONFIG.isTradingHalted) {
        return {
            canTrade: false,
            reasons: [`Trading halted: ${RISK_CONFIG.haltReason}`],
            positionSizing: null,
            checks: {},
        };
    }

    const reasons = [];

    // Run all checks in parallel
    const [balanceCheck, positionCheck, drawdownCheck, killSwitchCheck] = await Promise.all([
        checkMinimumBalance(),
        checkPositionLimits(),
        checkMaxDrawdown(),
        checkDailyKillSwitch(),
    ]);

    if (!balanceCheck.isSafe) {
        reasons.push(`Balance too low: $${balanceCheck.currentBalance} < $${balanceCheck.minimumBalance}`);
    }
    if (!positionCheck.canOpen) {
        reasons.push(`Position limit reached: ${positionCheck.currentPositions}/${positionCheck.maxPositions}`);
    }
    if (!drawdownCheck.isSafe) {
        reasons.push(`Max drawdown exceeded: ${drawdownCheck.drawdownPercent}%`);
    }
    if (!killSwitchCheck.isSafe) {
        reasons.push(`Daily loss limit exceeded: $${killSwitchCheck.todayPnL}`);
    }

    // If all checks pass, calculate position size
    let positionSizing = null;
    if (reasons.length === 0) {
        const accountBalance = balanceCheck.currentBalance;
        positionSizing = calculatePositionSize(accountBalance, entryPrice, stopLossPrice);
    }

    const canTrade = reasons.length === 0;

    if (canTrade) {
        console.log(
            `✅ Risk check passed. Position size: ${positionSizing.quantity} units ` +
            `($${positionSizing.positionValue})`
        );
    } else {
        console.warn(`❌ Risk check failed: ${reasons.join(', ')}`);
    }

    return {
        canTrade,
        reasons,
        positionSizing,
        checks: {
            balance: balanceCheck,
            positions: positionCheck,
            drawdown: drawdownCheck,
            killSwitch: killSwitchCheck,
        },
    };
}

// ==========================================
// TRADING HALT / RESUME
// ==========================================
function haltTrading(reason) {
    RISK_CONFIG.isTradingHalted = true;
    RISK_CONFIG.haltReason = reason;
    console.error(`🛑 TRADING HALTED: ${reason}`);
}

function resumeTrading() {
    RISK_CONFIG.isTradingHalted = false;
    RISK_CONFIG.haltReason = null;
    console.log('✅ Trading resumed');
}

function getRiskStatus() {
    return {
        isTradingHalted: RISK_CONFIG.isTradingHalted,
        haltReason: RISK_CONFIG.haltReason,
        config: {
            riskPerTrade: RISK_CONFIG.RISK_PER_TRADE_PERCENT,
            maxPositions: RISK_CONFIG.MAX_POSITIONS,
            dailyLossLimit: RISK_CONFIG.DAILY_LOSS_LIMIT_PERCENT,
            maxDrawdown: RISK_CONFIG.MAX_DRAWDOWN_PERCENT,
            minimumBalance: RISK_CONFIG.MINIMUM_BALANCE_USDT,
        },
    };
}

module.exports = {
    performRiskCheck,
    calculatePositionSize,
    checkDailyKillSwitch,
    checkMaxDrawdown,
    checkPositionLimits,
    checkMinimumBalance,
    getAccountBalance,
    haltTrading,
    resumeTrading,
    getRiskStatus,
};

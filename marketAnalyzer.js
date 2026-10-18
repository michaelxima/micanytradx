// marketAnalyzer.js
// Phase E: Advanced trading-logic filters that raise signal quality.
//
//   Module 1  checkHigherTimeframeTrend — MTF confirmation (1h trend must agree)
//   Module 2  checkVolumeRegime         — refuse dead/choppy markets (volume spike)
const { EMA } = require('technicalindicators');

// ==========================================
// MODULE 1: Multiple Timeframe (MTF) Confirmation
// ==========================================
/**
 * Confirms the higher timeframe (e.g. 1h) agrees with the lower-timeframe entry.
 * Bullish when the latest 1h close is above the 1h 50-EMA.
 * @param {number[]} higherTimeframePrices - 1h closing prices, oldest first.
 * @returns {{ isBullishHigherTrend: boolean, current1hEma?: number, current1hPrice?: number, reason?: string }}
 */
function checkHigherTimeframeTrend(higherTimeframePrices) {
    if (!Array.isArray(higherTimeframePrices) || higherTimeframePrices.length < 50) {
        return { isBullishHigherTrend: false, reason: 'Insufficient 1h data' };
    }

    const ema50 = EMA.calculate({ values: higherTimeframePrices, period: 50 });
    const current1hEma = ema50[ema50.length - 1];
    const current1hPrice = higherTimeframePrices[higherTimeframePrices.length - 1];

    if (current1hEma === undefined || !Number.isFinite(current1hPrice)) {
        return { isBullishHigherTrend: false, reason: '1h EMA not ready' };
    }

    const isBullishHigherTrend = current1hPrice > current1hEma;
    return {
        isBullishHigherTrend,
        current1hEma: parseFloat(current1hEma.toFixed(2)),
        current1hPrice: parseFloat(current1hPrice.toFixed(2)),
    };
}

// ==========================================
// MODULE 2: Market Regime Detection (Volume Filter)
// ==========================================
/**
 * Confirms the just-closed candle traded on meaningfully above-average volume,
 * filtering out low-volume chop. Uses the prior 20 candles (excludes the
 * current one to avoid look-ahead bias).
 * @param {number[]} volumes - Volume series, most recent last.
 * @param {number} currentVolume - Volume of the candle that just closed.
 * @returns {{ isHighVolume: boolean, volumeRatio?: number, avgVolume?: number, reason?: string }}
 */
function checkVolumeRegime(volumes, currentVolume) {
    if (!Array.isArray(volumes) || volumes.length < 20) {
        return { isHighVolume: false, reason: 'Insufficient volume data' };
    }

    // Prior 20 volumes, excluding the current candle.
    const recentVolumes = volumes.slice(-21, -1);
    if (recentVolumes.length === 0) {
        return { isHighVolume: false, reason: 'Insufficient volume data' };
    }
    const avgVolume = recentVolumes.reduce((sum, vol) => sum + vol, 0) / recentVolumes.length;

    if (!(avgVolume > 0)) {
        return { isHighVolume: false, volumeRatio: 0, avgVolume: 0, reason: 'Zero average volume' };
    }

    const volumeRatio = currentVolume / avgVolume;
    const isHighVolume = volumeRatio >= 1.5; // require >= 150% of average

    return {
        isHighVolume,
        volumeRatio: parseFloat(volumeRatio.toFixed(2)),
        avgVolume: parseFloat(avgVolume.toFixed(2)),
    };
}

module.exports = {
    checkHigherTimeframeTrend,
    checkVolumeRegime,
};

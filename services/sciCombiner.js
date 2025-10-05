// backend/services/sciCombiner.js
// -------------------------------------------------------------
// SCI Master Combiner (plug your formula here)
//
// The server provides these z-scored series in Z (oldest → newest):
//   Z.zRET1, Z.zMOM5, Z.zRSI14, Z.zATRpct, Z.zGAP, Z.zVOL, Z.zOBV, Z.zPctB
//
// Export a single function (Z, t) → numeric score.
// Higher = more bullish, lower = more bearish. Return NaN if undefined.
// -------------------------------------------------------------

'use strict';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const nz = (v) => (Number.isFinite(v) ? v : 0);

module.exports = function combiner(Z, t) {
  // --- Example baseline (replace with YOUR formula) ---
  // Trend + momentum + breadth, minus volatility penalty, mild gap effect.
  const score =
      1.00 * nz(Z.zMOM5?.[t])     // 5-day momentum
    + 0.60 * nz(Z.zRSI14?.[t])    // RSI z
    + 0.30 * nz(Z.zPctB?.[t])     // Bollinger %B z
    + 0.20 * nz(Z.zOBV?.[t])      // OBV slope/level z
    + 0.15 * nz(Z.zVOL?.[t])      // volume regime z
    + 0.20 * nz(Z.zGAP?.[t])      // gap context z (sign per your route)
    - 0.70 * nz(Z.zATRpct?.[t]);  // volatility damper

  // Clip extremes to be safe.
  const s = clamp(score, -5, 5);
  return Number.isFinite(s) ? s : NaN;
};

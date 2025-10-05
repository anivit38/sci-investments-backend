// backend/services/sciCombiner.js
// Replace the body with YOUR SCI Master Formula. Keep the names as-is so wiring works.
module.exports = function combiner(Z, t) {
  // Available z-series we build for you in the route:
  // Z.zRET1, Z.zMOM5, Z.zRSI14, Z.zATRpct, Z.zGAP, Z.zVOL, Z.zOBV, Z.zPctB
  // Example placeholder (DELETE and paste YOUR formula):
  const s =
    (Z.zMOM5[t] ?? 0) +
    0.5 * (Z.zRSI14[t] ?? 0) -
    0.5 * (Z.zATRpct[t] ?? 0);
  return Number.isFinite(s) ? s : NaN;
};

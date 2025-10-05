// backend/services/volatility.js
const { zScoreMAD } = require('./math');

function bucketTickerVol(compPct) {
  if (compPct <= -30) return { label: 'Very Low',  score: 3 };
  if (compPct <  -10) return { label: 'Low',       score: 2 };
  if (compPct <=  10) return { label: 'Normal',    score: 1 };
  if (compPct <   30) return { label: 'High',      score: 0 };
  return { label: 'Very High', score: -1 };
}
function bucketMarketVol(compPct) {
  if (compPct <= -20) return { label: 'Very Calm',    score: 3 };
  if (compPct <   -5) return { label: 'Calm',         score: 2 };
  if (compPct <=   5) return { label: 'Typical',      score: 1 };
  if (compPct <   20) return { label: 'Stressed',     score: 0 };
  return { label: 'Very Stressed', score: -1 };
}

// safer percent: if both are 0, return 0 (avoid -100 artifact)
function compPercent(today, pastAvg) {
  if (!Number.isFinite(today) || !Number.isFinite(pastAvg)) {
    // fall back to 0 rather than explode the score
    return 0;
  }
  if (today === 0 && pastAvg === 0) return 0;
  return ((today / (pastAvg || 1)) - 1) * 100;
}

// Sum helpers that ignore NaN
function safeSum(...xs) {
  return xs.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
}

// TVol / MVol
function computeTickerVol(zBBW, zATR, zRVOL, zIV) {
  return safeSum(zBBW, zATR, zRVOL, zIV); // treat missing IV as 0
}
function computeMarketVol(zVIX, zEPU, zMDD) {
  return safeSum(zVIX, zEPU, zMDD); // treat missing EPU/MDD as 0
}

module.exports = {
  zScoreMAD, compPercent, bucketTickerVol, bucketMarketVol,
  computeTickerVol, computeMarketVol
};

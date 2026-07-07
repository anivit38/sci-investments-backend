// regimeModel.js
//
// Extracted, unchanged, from the regime-detection step of /api/check-stock
// (server.js). This is the ONLY regime model in SCI — a Hurst R/S exponent
// plus a simple 2-state (high-vol / low-vol) volatility classifier. It is
// NOT a fitted Gaussian Mixture Model and NOT a fitted Hidden Markov Model
// with a learned transition matrix, despite the "GMM/HMM" label used in the
// UI — that label describes the intent/spirit of the check, not a literal
// EM/Baum-Welch fit. Anything downstream (including the quant layer) that
// needs "the existing regime model" means these two functions.
//
// Logic is copied verbatim from server.js so behavior for the existing
// Stock Checker "Regime Detection" section is 100% unchanged.

// ── Hurst Exponent (R/S analysis) ──────────────────────────────
function hurstRS(returns) {
  const lags = [8, 16, 32, 64, 128].filter(l => l < returns.length * 0.5);
  if (lags.length < 2) return 0.5;
  const pts = lags.map(lag => {
    const chunks = [];
    for (let start = 0; start + lag <= returns.length; start += lag) {
      const sub = returns.slice(start, start + lag);
      const mu = sub.reduce((a, b) => a + b, 0) / sub.length;
      let cum = 0, maxCum = -Infinity, minCum = Infinity;
      const diffs = sub.map(v => { cum += (v - mu); maxCum = Math.max(maxCum, cum); minCum = Math.min(minCum, cum); return v - mu; });
      const R = maxCum - minCum;
      const S = Math.sqrt(diffs.map(d => d * d).reduce((a, b) => a + b, 0) / sub.length);
      if (S > 0) chunks.push(R / S);
    }
    const avgRS = chunks.length ? chunks.reduce((a, b) => a + b, 0) / chunks.length : null;
    return avgRS ? { logLag: Math.log(lag), logRS: Math.log(avgRS) } : null;
  }).filter(Boolean);

  if (pts.length < 2) return 0.5;
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.logLag, 0);
  const sy = pts.reduce((a, p) => a + p.logRS, 0);
  const sxy = pts.reduce((a, p) => a + p.logLag * p.logRS, 0);
  const sxx = pts.reduce((a, p) => a + p.logLag * p.logLag, 0);
  const H = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return Math.max(0.01, Math.min(0.99, H));
}

// ── Volatility regime (2-state: low-vol trending vs high-vol mean-reverting) ──
function volRegime(returns) {
  const w = 20;
  const annVols = [];
  for (let i = w; i <= returns.length; i++) {
    const slice = returns.slice(i - w, i);
    const mu = slice.reduce((a, b) => a + b, 0) / w;
    const variance = slice.map(r => (r - mu) ** 2).reduce((a, b) => a + b, 0) / w;
    annVols.push(Math.sqrt(variance * 252));
  }
  if (!annVols.length) return { current: null, regime: "unknown" };
  const sorted = [...annVols].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const current = annVols[annVols.length - 1];
  // Count days in each state over last 40 readings
  const recent = annVols.slice(-40);
  const highDays = recent.filter(v => v > median * 1.1).length;
  const lowDays  = recent.filter(v => v <= median * 1.1).length;
  return {
    currentPct: +(current * 100).toFixed(1),
    medianPct:  +(median * 100).toFixed(1),
    highDays, lowDays,
    regime: highDays > lowDays ? "high-vol" : "low-vol",
    // per-day state sequence, used by the quant layer to derive an empirical
    // day-to-day transition frequency (see quant/modelA.js) — NOT part of
    // the original check-stock output, purely additive.
    dailyStates: annVols.map(v => (v > median * 1.1 ? "high-vol" : "low-vol")),
  };
}

module.exports = { hurstRS, volRegime };

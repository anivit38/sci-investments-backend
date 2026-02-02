// services/formula3.js
// ------------------------------------------------------------------
// SCI Next-Day Prediction (runtime).
// - Uses your daily candles + optional VIX/sentiment/IV inputs.
// - Builds the z-scored feature pack expected by YOUR combiner.
// - Delegates the final "score" to ./sciCombiner.js (your formula).
// - Maps that score to Up/Down/Neutral + probUp + magnitude.
// ------------------------------------------------------------------

'use strict';

const { RSI, SMA, ATR, BollingerBands } = require('technicalindicators');
const combiner = require('./sciCombiner'); // ← YOUR formula lives here

/* ================= Tunables ================= */
const CFG = {
  // Probability mapping (kept mild; you can tweak)
  TEMP      : Number(process.env.SCI_TEMP      || 1.35),
  PMIN      : Number(process.env.SCI_PMIN      || 0.20),
  PMAX      : Number(process.env.SCI_PMAX      || 0.82),
  SCORE_CAP : Number(process.env.SCI_SCORE_CAP || 0.90),

  // Decision band around 0 for Neutral
  NEUTRAL_BAND: Number(process.env.SCI_NEUTRAL_BAND || 0.15),

  // Z lookback (robust median/MAD)
  Z_LOOKBACK: Number(process.env.SCI_Z_LOOKBACK || 252),

  // Expected magnitude scale
  MAGNITUDE_MIN: 0.002, // 0.2%
  MAGNITUDE_MAX: 0.08,  // 8%
};

const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeNum = (n, fb = 0) => (Number.isFinite(+n) ? +n : fb);
const nz      = (n) => (Number.isFinite(n) ? n : 0);

const eps = 1e-12;
const log = (x) => Math.log(Math.max(x, eps));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/* ================ Small utils ================ */
function seriesFromCandles(candles) {
  const C = candles.map(c => +c.close  || 0);
  const O = candles.map(c => +c.open   || 0);
  const H = candles.map(c => +c.high   || 0);
  const L = candles.map(c => +c.low    || 0);
  const V = candles.map(c => +c.volume || 0);
  return { O, H, L, C, V };
}

function obvSeries(C, V) {
  const n = Math.min(C.length, V.length);
  const obv = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dir = Math.sign(C[i] - C[i - 1]);
    obv[i] = obv[i - 1] + dir * (V[i] || 0);
  }
  return obv;
}

function pctBSeries(C, period = 20, std = 2) {
  // technicalindicators returns only when enough lookback exists; align to C
  const bb = BollingerBands.calculate({ period, stdDev: std, values: C });
  const out = Array(C.length).fill(null);
  for (let i = 0; i < C.length; i++) {
    const j = i - (period - 1);
    if (j >= 0 && bb[j]) {
      const lower = bb[j].lower;
      const upper = bb[j].upper;
      const den = (upper - lower);
      out[i] = den === 0 ? 0.5 : clamp((C[i] - lower) / den, 0, 1);
    }
  }
  return out;
}

function ema(values, n) {
  const k = 2 / (n + 1);
  const out = Array(values.length).fill(NaN);
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    out[i] = i === 0 ? x : out[i - 1] + k * (x - out[i - 1]);
  }
  return out;
}

function obvSlope(obv, n = 10) {
  const out = Array(obv.length).fill(0);
  for (let i = 0; i < obv.length; i++) {
    out[i] = i >= n ? (obv[i] - obv[i - n]) : 0;
  }
  return out;
}

/* -------- Robust rolling z (median/MAD) — missing helper added -------- */
function median(arr) {
  const a = [...arr].filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}
function mad(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return NaN;
  const med = median(a);
  const dev = a.map(x => Math.abs(x - med));
  return 1.4826 * median(dev); // consistency factor to ~std
}
function winsorize(arr, limit = 3.5) {
  return arr.map(z => Math.max(-limit, Math.min(limit, z)));
}
function rollingRobustZ(values, L, { winsorFinal = true } = {}) {
  const n = values.length;
  const z = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    const start = Math.max(0, t - L);
    const end = t; // exclude current
    if (end - start <= 1) continue;
    const window = values.slice(start, end).filter(Number.isFinite);

    let med1 = median(window);
    let mad1 = mad(window);
    const filtered =
      mad1 > eps ? window.filter(x => Math.abs((x - med1) / mad1) <= 3.5) : window;

    const med2 = median(filtered);
    const mad2 = mad(filtered);
    if (!(mad2 > eps)) continue;

    z[t] = (values[t] - med2) / mad2;
  }
  return winsorFinal ? winsorize(z, 3.5) : z;
}
/* --------------------------------------------------------------------- */

function scoreToProb(s, temp = CFG.TEMP) {
  const k = 3.0;
  const p = sigmoid((clamp(s, -CFG.SCORE_CAP, CFG.SCORE_CAP) * k) / (temp || 1));
  return clamp(p, CFG.PMIN, CFG.PMAX);
}

// Magnitude helper (renamed to avoid shadowing when used below)
function expectedMagnitudeFromATR(atrPctSeries, score) {
  const atr = atrPctSeries.at(-1) || 0.01;
  const absS = Math.abs(score);
  // Mildly scale with conviction, anchor to ATR%
  const base = atr * (1 + 0.25 * absS);
  return clamp(base, CFG.MAGNITUDE_MIN, CFG.MAGNITUDE_MAX);
}

/* ================ Feature pack (Z.*) ================ */
/**
 * Build z-scored metrics required by your combiner.
 * Z keys provided:
 *   zRET1, zMOM5, zRSI14, zATRpct, zGAP, zVOL, zOBV, zPctB
 */
function buildZPack(candles) {
  const { O, H, L, C, V } = seriesFromCandles(candles);
  const n = C.length;
  if (n < 40) return null;

  // 1-day log return & 5-day momentum
  const ret1 = C.map((c, i) => (i ? log(c / (C[i - 1] || c)) : 0));
  const mom5 = C.map((c, i) => (i >= 5 ? (c - C[i - 5]) / (C[i - 5] || 1) : 0));

  // RSI14 (raw → z of raw)
  const rsi = RSI.calculate({ period: 14, values: C });
  const rsiFull = Array(n).fill(null);
  for (let i = 0; i < n; i++) rsiFull[i] = i >= 13 ? rsi[i - 13] : null;

  // ATR% (Wilder)
  const atr14 = ATR.calculate({ period: 14, high: H, low: L, close: C });
  const atrFull = Array(n).fill(null);
  for (let i = 0; i < n; i++) atrFull[i] = i >= 13 ? atr14[i - 13] : null;
  const atrPct = atrFull.map((a, i) => (a && C[i] ? a / C[i] : 0));

  // Gap normalized by ATR%
  const gap = C.map((c, i) => (i ? log((O[i] || c) / (C[i - 1] || O[i])) : 0));
  const gapNorm = gap.map((g, i) => (atrPct[i] ? Math.sign(g) * Math.min(Math.abs(g) / atrPct[i], 5) : 0));

  // VOL regime (log RVOL delta)
  const vSma20 = SMA.calculate({ period: 20, values: V });
  const rvol = V.map((v, i) => (i >= 19 ? (v / (vSma20[i - 19] || 1)) : 1));
  const logRV = rvol.map(x => log(Math.max(x, 1e-9)));
  const dLogRV = logRV.map((x, i) => (i ? x - logRV[i - 1] : 0));

  // OBV + 10-bar slope, then z
  const obv = obvSeries(C, V);
  const obvSl10 = obvSlope(obv, 10);

  // Bollinger %B (20, 2sd)
  const pctB = pctBSeries(C, 20, 2);

  // --- Robust rolling z's (median/MAD) ---
  const zRET1   = rollingRobustZ(ret1,   CFG.Z_LOOKBACK);
  const zMOM5   = rollingRobustZ(mom5,   CFG.Z_LOOKBACK);
  const zRSI14  = rollingRobustZ(rsiFull.map(v => (v == null ? NaN : v)), CFG.Z_LOOKBACK);
  const zATRpct = rollingRobustZ(atrPct, CFG.Z_LOOKBACK);
  const zGAP    = rollingRobustZ(gapNorm, CFG.Z_LOOKBACK);
  const zVOL    = rollingRobustZ(dLogRV,  CFG.Z_LOOKBACK);
  const zOBV    = rollingRobustZ(obvSl10, CFG.Z_LOOKBACK);
  const zPctB   = rollingRobustZ(pctB.map(v => (v == null ? NaN : v)), CFG.Z_LOOKBACK);

  return { zRET1, zMOM5, zRSI14, zATRpct, zGAP, zVOL, zOBV, zPctB };
}

/* ================ Public API ================ */
/**
 * predictNextDay(inputs)
 * inputs:
 *   {
 *     candles: [{t, open, high, low, close, volume}, ...],
 *     vix: number[] (aligned to candles)   // optional
 *     sentiment, impliedVol, epu, mdd: arrays (optional – ignored here),
 *     mode: 'during' | 'after',
 *     dayRows: attached intraday rows (optional)
 *   }
 */
function predictNextDay(inputs) {
  const candles = Array.isArray(inputs?.candles) ? inputs.candles.slice() : [];
  if (candles.length < 40) {
    return {
      prediction: { label: 'Neutral', probUp: 0.5, expectedMagnitude: 0 },
      snapshot: { reason: 'insufficient_candles', n: candles.length }
    };
  }

  // 1) Build Z-pack for your combiner
  const Z = buildZPack(candles);
  if (!Z) {
    return {
      prediction: { label: 'Neutral', probUp: 0.5, expectedMagnitude: 0 },
      snapshot: { reason: 'feature_build_failed' }
    };
  }

  // 2) Run YOUR formula (via sciCombiner.js) to get the scalar score S_t
  const t = candles.length - 1;
  const s = combiner(Z, t); // ← your formula decides sign/magnitude
  const score = clamp(safeNum(s), -CFG.SCORE_CAP, CFG.SCORE_CAP);

  // 3) Turn score into categorical label
  const band = CFG.NEUTRAL_BAND;
  let label = 'Neutral';
  if (score > +band) label = 'Up';
  if (score < -band) label = 'Down';

  // 4) Probability & magnitude
  const probUp = +scoreToProb(score, CFG.TEMP).toFixed(4);

  // ATR% series for magnitude anchor
  const { O, H, L, C } = seriesFromCandles(candles);
  const atr14 = ATR.calculate({ period: 14, high: H, low: L, close: C });
  const atrFull = Array(C.length).fill(null);
  for (let i = 0; i < C.length; i++) atrFull[i] = i >= 13 ? atr14[i - 13] : null;
  const atrPctSeries = atrFull.map((a, i) => (a && C[i] ? a / C[i] : 0));

  const magnitude = +expectedMagnitudeFromATR(atrPctSeries, score).toFixed(4);

  // 5) Snapshot for UI / debugging
  const snapshot = {
    ts: new Date().toISOString(),
    last: candles.at(-1)?.t || null,
    score,
    probUp,
    label,
    cfg: {
      TEMP: CFG.TEMP,
      PMIN: CFG.PMIN,
      PMAX: CFG.PMAX,
      SCORE_CAP: CFG.SCORE_CAP,
      NEUTRAL_BAND: CFG.NEUTRAL_BAND
    },
    zMeta: Object.keys(Z).reduce((m, k) => (m[k] = Z[k].at(-1), m), {}),
    vix: Array.isArray(inputs.vix) ? inputs.vix.at(-1) : null,
    mode: inputs.mode || 'during'
  };

  return { prediction: { label, probUp, expectedMagnitude: magnitude }, snapshot };
}

module.exports = { predictNextDay };

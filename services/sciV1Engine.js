// backend/services/sciV1Engine.js
// SCI V1 — rule engine + optional ridge regression (TFJS)
// Rule logic kept intact, with added: (a) ATR gating, (b) calibrated pUp with
// temperature + clamps, (c) expected magnitude estimate, (d) small perf fix.

const tf = require('@tensorflow/tfjs-node');

/* ========================= Tunables (env) ========================= */
const CONFIG = {
  ATR_MAX   : Number(process.env.SCIV1_ATR_MAX || 0.03), // skip / downweight decisions when daily ATR% is above this
  TEMP      : Number(process.env.SCIV1_TEMP    || 1.4),  // >1 flattens confidence (reduces extremes)
  PMIN      : Number(process.env.SCIV1_PMIN    || 0.20), // min probability after clamp
  PMAX      : Number(process.env.SCIV1_PMAX    || 0.80), // max probability after clamp
  SCORE_CAP : Number(process.env.SCIV1_SCORE_CAP || 0.85) // cap absolute score before mapping to prob
};

/* ========================= Helpers ========================= */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeDiv = (a, b, eps = 1e-9) => (Math.abs(b) < eps ? 0 : a / b);
const mean = (arr) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
const stdev = (arr) => {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)) || 1e-12);
};

function rollingZ(series, W = 252) {
  // z of *last* value using up to last W samples (no leakage)
  const n = series.length;
  const w = Math.min(W, n);
  const window = series.slice(n - w);
  const m = mean(window);
  const s = stdev(window);
  return clamp(safeDiv(series[n - 1] - m, s), -3, 3);
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

function sma(values, n) {
  const out = Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function wilderTR(rows) {
  const tr = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) tr.push(rows[i].high - rows[i].low);
    else {
      const pc = rows[i - 1].close;
      const h = rows[i].high, l = rows[i].low;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  return tr;
}

function emaArray(arr, n) {
  const k = 2 / (n + 1);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    out[i] = i === 0 ? arr[i] : out[i - 1] + k * (arr[i] - out[i - 1]);
  }
  return out;
}

/* ========================= Indicators ========================= */
function computeIndicators(rows, cfg = {}) {
  // rows: [{date, open, high, low, close, volume}] oldest→newest
  const n = rows.length;
  if (n < 40) throw new Error('need >=40 rows');
  const O = rows.map(r => r.open);
  const H = rows.map(r => r.high);
  const L = rows.map(r => r.low);
  const C = rows.map(r => r.close);
  const V = rows.map(r => r.volume || 0);

  // Spread S_t = (EMA10-EMA20)/EMA20
  const ema10 = ema(C, 10);
  const ema20 = ema(C, 20);
  const S = C.map((_, i) => safeDiv(ema10[i] - ema20[i], Math.abs(ema20[i]) || 1e-9));
  const zS = rollingZ(S, cfg.zWin || 252);
  const dS = S[n - 1] - S[n - 2];
  const z_dS = rollingZ(S.map((x, i) => (i === 0 ? 0 : x - S[i - 1])).slice(1), cfg.zWin || 252);

  // MACD 12,26 and signal 9
  const ema12 = ema(C, 12);
  const ema26 = ema(C, 26);
  const macdLine = C.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(macdLine, 9);
  const hist = macdLine.map((x, i) => x - signal[i]);
  const dHist = hist[n - 1] - hist[n - 2];
  const z_dHist = rollingZ(hist.map((x, i) => (i === 0 ? 0 : x - hist[i - 1])).slice(1), cfg.zWin || 252);

  // RVOL (20), log, delta, z
  const vSma20 = sma(V, 20);
  const rvol = V.map((v, i) => (vSma20[i] ? v / vSma20[i] : 1));
  const logRV = rvol.map(x => Math.log(Math.max(x, 1e-9)));
  const dLogRV = logRV[n - 1] - logRV[n - 2];
  const z_dLogRV = rollingZ(logRV.map((x, i) => (i === 0 ? 0 : x - logRV[i - 1])).slice(1), cfg.zWin || 252);

  // OBV and slope10
  const obv = Array(n).fill(0);
  for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + Math.sign(C[i] - C[i - 1]) * (V[i] || 0);
  const obvSlope10 = obv[n - 1] - obv[n - 11 >= 0 ? n - 11 : 0];
  const z_obvSl = rollingZ(obv.map((x, i) => (i >= 10 ? x - obv[i - 10] : 0)), cfg.zWin || 252);

  // %K (14)
  const HH14 = Math.max(...H.slice(n - 14));
  const LL14 = Math.min(...L.slice(n - 14));
  const kDen = (HH14 - LL14);
  const K = kDen === 0 ? 0 : clamp((C[n - 1] - LL14) / kDen, 0, 1);

  // Bollinger %B (20, 2sd)
  const win20 = C.slice(n - 20);
  const m20 = mean(win20);
  const sd20 = stdev(win20);
  const upper = m20 + 2 * sd20;
  const lower = m20 - 2 * sd20;
  const bDen = (upper - lower);
  const pctB = bDen === 0 ? 0.5 : clamp((C[n - 1] - lower) / bDen, 0, 1);

  // CLV
  const clvDen = (H[n - 1] - L[n - 1]);
  const CLV = clvDen === 0 ? 0 : clamp(((2 * C[n - 1] - H[n - 1] - L[n - 1]) / clvDen), -1, 1);

  // ATR% (Wilder via EMA of TR) + perf-friendly z of ATR%
  const TR = wilderTR(rows);
  const ATR14series = emaArray(TR, 14);
  const ATR14 = ATR14series[n - 1];
  const atrPct = safeDiv(ATR14, C[n - 1]);
  const atrPctSeries = ATR14series.map((a, i) => safeDiv(a, C[i] || 1));
  const z_ATRPct = rollingZ(atrPctSeries.slice(-Math.max(40, cfg.zWin || 252)), cfg.zWin || 252);

  // BBW + delta + z
  const BBW = safeDiv(upper - lower, m20 || 1e-9);
  const prevWindow = C.slice(n - 21, n - 1);
  const m20p = mean(prevWindow);
  const sd20p = stdev(prevWindow);
  const upperP = m20p + 2 * sd20p;
  const lowerP = m20p - 2 * sd20p;
  const BBWprev = safeDiv(upperP - lowerP, m20p || 1e-9);
  const dBBW = BBW - BBWprev;
  const z_BBW = rollingZ(C.map((_, i) => {
    if (i < 19) return 0;
    const win = C.slice(i - 19, i + 1);
    const m = mean(win), sd = stdev(win);
    const u = m + 2 * sd, l = m - 2 * sd;
    return safeDiv(u - l, m || 1e-9);
  }), cfg.zWin || 252);
  const z_dBBW = rollingZ(C.map((_, i) => {
    if (i < 20) return 0;
    const win = C.slice(i - 19, i + 1); const winP = C.slice(i - 20, i);
    const m = mean(win), sd = stdev(win); const u = m + 2 * sd, l = m - 2 * sd;
    const mP = mean(winP), sdP = stdev(winP); const uP = mP + 2 * sdP, lP = mP - 2 * sdP;
    return safeDiv(safeDiv(u - l, m || 1e-9) - safeDiv(uP - lP, mP || 1e-9), 1);
  }), cfg.zWin || 252);

  // Gaps
  const g = Math.log(Math.max(O[n - 1], 1e-9) / Math.max(C[n - 2] || O[n - 1], 1e-9));
  const gapNorm = atrPct ? Math.abs(g) / Math.max(atrPct, 1e-6) : 0;
  let fill = 0; // sign-adjusted fill: 0 held, -1 full fill
  if (g > 0) fill = safeDiv(C[n - 1] - O[n - 1], O[n - 1] - (C[n - 2] || O[n - 1]));
  else if (g < 0) fill = safeDiv(O[n - 1] - C[n - 1], (C[n - 2] || O[n - 1]) - O[n - 1]);
  fill = clamp(fill, -1, 1);
  const strongClose = (CLV > 0.3) || (C[n - 1] >= O[n - 1]);
  const weakClose   = (CLV < -0.3) || (C[n - 1] <= O[n - 1]);

  // Universe metrics (price + dollar volume median 60d)
  const priceOk = C[n - 1] >= 3;
  const dollar = C.map((c, i) => (c || 0) * (V[i] || 0));
  const med60 = (() => {
    const last60 = dollar.slice(Math.max(0, n - 60));
    const arr = [...last60].sort((a, b) => a - b);
    if (!arr.length) return 0; const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  })();
  const liqOkUSD = med60 >= 10_000_000; // USD 10M default

  return {
    // core z's / features
    zS, dS, z_dS, z_dHist, K, pctB, CLV,
    logRV: logRV[n - 1], dLogRV, z_dLogRV,
    obvSlope10, z_obvSl,
    atrPct, z_ATRPct,
    BBW, dBBW, z_BBW, z_dBBW,
    g, gapNorm, fill, strongClose, weakClose,
    priceOk, liqOkUSD,
    // pass-through raw refs for explainability
    last: { O: O[n - 1], H: H[n - 1], L: L[n - 1], C: C[n - 1], V: V[n - 1] }
  };
}

/* ========================= Rule Logic ========================= */
function decideFromIndicators(f) {
  // Buckets
  const TrendPlus = f.zS > +0.5;
  const TrendMinus = f.zS < -0.5;
  const TrendChop = Math.abs(f.zS) <= 0.3;
  const AccelBull = (f.z_dS > 0.3) || (f.z_dHist > 0.3);
  const AccelBear = (f.z_dS < -0.3) || (f.z_dHist < -0.3);
  const AccelBullStrong = (f.z_dS > 0.8) || (f.z_dHist > 0.8);
  const AccelBearStrong = (f.z_dS < -0.8) || (f.z_dHist < -0.8);

  const FlowPlus = (f.logRV > 0) || (f.obvSlope10 > 0 && Math.abs(f.z_obvSl) > 0.3);
  const FlowMinus = (f.logRV <= 0) || (f.obvSlope10 < 0 && Math.abs(f.z_obvSl) > 0.3);

  const LocBull = (f.K > 0.7) || (f.pctB > 0.7) || (f.CLV > 0.5);
  const LocBear = (f.K < 0.3) || (f.pctB < 0.3) || (f.CLV < -0.5);

  const BBWRelease = (f.z_BBW < -0.7) && (f.z_dBBW > +0.5);
  const dLogRVSpikePos = Math.abs(f.z_dLogRV) > 0.7 && (f.CLV > 0 || f.K > 0.5 || f.pctB > 0.5);

  // EMA cross (computed via S sign change)
  const CrossUp = (f.dS > 0) && (f.zS > 0) && FlowPlus;
  const CrossDown = (f.dS < 0) && (f.zS < 0) && FlowMinus;

  // Neutral fence
  const inNeutralFence = (f.zS >= -0.5 && f.zS <= 0.5) && (f.K >= 0.3 && f.K <= 0.7) && (f.pctB >= 0.4 && f.pctB <= 0.6);

  // Exhaustion & volatility neutralizers
  const Exhaustion = (f.logRV <= 0) && ((f.pctB > 1.0) || (f.K > 0.9));
  const VolSpike = (f.z_ATRPct >= 1.5);

  // Base rules
  let base = 'Neutral';
  if ( (f.zS > 0.5) && ( (f.z_dS > 0) || (f.z_dHist > 0) ) && FlowPlus && ( (f.K > 0.7) || (f.pctB > 0.7) ) ) base = 'Up';
  if ( (f.zS < -0.5) && ( (f.z_dS < 0) || (f.z_dHist < 0) ) && FlowMinus && ( (f.K < 0.3) || (f.pctB < 0.3) ) ) base = 'Down';
  if (TrendChop) {
    if (FlowPlus && LocBull) base = 'Up';
    else if (FlowMinus && LocBear) base = 'Down';
    else base = 'Neutral';
  }
  if (inNeutralFence) base = 'Neutral';

  // Apply neutralizers (downgrade one rank when triggered)
  if (Exhaustion) base = 'Neutral';
  if (VolSpike) {
    if (base === 'Up' || base === 'Down') base = 'Neutral';
  }

  // Gap overrides
  const cont_up   = (f.g > 0) && (f.gapNorm >= 0.5) && FlowPlus && f.strongClose;
  const fade_up   = (f.g > 0) && (f.gapNorm >= 0.5) && FlowMinus && (f.fill <= -0.5 || f.weakClose);
  const cont_down = (f.g < 0) && (f.gapNorm >= 0.5) && FlowMinus && f.weakClose;
  const rebound_down = (f.g < 0) && (f.gapNorm >= 0.5) && FlowPlus && (f.fill <= -0.5 || f.strongClose);

  let afterGaps = base;
  if (base === 'Up' && fade_up) afterGaps = 'Neutral';
  if (base === 'Down' && rebound_down) afterGaps = 'Neutral';
  if (base === 'Neutral' && cont_up) afterGaps = 'Up';
  if (base === 'Neutral' && cont_down) afterGaps = 'Down';

  // Shift aggregator
  const bullEvents = [AccelBull, dLogRVSpikePos, CrossUp, (BBWRelease && (f.CLV > 0.3) && FlowPlus)].filter(Boolean).length;
  const bearEvents = [AccelBear, Math.abs(f.z_dLogRV) > 0.7 && (f.CLV < 0 || f.K < 0.5 || f.pctB < 0.5), CrossDown, (BBWRelease && (f.CLV < -0.3) && FlowMinus)].filter(Boolean).length;

  let final = afterGaps;
  if (afterGaps === 'Neutral' && (f.zS > 0) && FlowPlus && bullEvents >= 2) final = 'Up';
  if (afterGaps === 'Neutral' && (f.zS < 0) && FlowMinus && bearEvents >= 2) final = 'Down';
  if (afterGaps === 'Up' && (bearEvents >= 2) && AccelBearStrong) final = 'Neutral';
  if (afterGaps === 'Down' && (bullEvents >= 2) && AccelBullStrong) final = 'Neutral';

  // Continuous confidence score in [-1,1]
  const confUp = (
    (f.zS > 0 ? 0.3 : 0) + (AccelBull?0.2:0) + (FlowPlus?0.2:0) + (LocBull?0.2:0) + (cont_up?0.2:0)
  );
  const confDn = (
    (f.zS < 0 ? 0.3 : 0) + (AccelBear?0.2:0) + (FlowMinus?0.2:0) + (LocBear?0.2:0) + (cont_down?0.2:0)
  );
  let score = clamp(confUp - confDn, -1, 1);

  // Neutralizers shrink confidence
  if (VolSpike || Exhaustion) score *= 0.5;
  if (final === 'Neutral') score *= 0.5;

  // === New safety rails: ATR gating + score cap ===
  const tooVolatile = f.atrPct > CONFIG.ATR_MAX;
  if (tooVolatile) {
    // Keep categorical label, but squash conviction to reduce trade weight
    score *= 0.5;
    if (final !== 'Neutral') final = 'Neutral'; // optional: gate outright
  }
  score = clamp(score, -CONFIG.SCORE_CAP, CONFIG.SCORE_CAP);

  return {
    base, afterGaps, final, score,
    buckets: { TrendPlus, TrendMinus, TrendChop, AccelBull, AccelBear, FlowPlus, FlowMinus, LocBull, LocBear, BBWRelease },
    neutralizers: { Exhaustion, VolSpike, inNeutralFence },
    gaps: { cont_up, fade_up, cont_down, rebound_down },
  };
}

/* ========================= Prob & Magnitude ========================= */
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function scoreToProbability(score, temp = CONFIG.TEMP) {
  // Map score∈[-1,1] → probability via logistic; temp>1 flattens extremes.
  const k = 3.0; // slope before temperature (empirically reasonable)
  const p = sigmoid((score * k) / (temp || 1));
  return clamp(p, CONFIG.PMIN, CONFIG.PMAX);
}

function expectedMagnitude(f, score) {
  // Anchor to ATR%, then scale mildly by absolute conviction and recent flow.
  const absScore = Math.abs(score);
  const flowKick = (f.logRV > 0 ? 0.05 : -0.02) + (Math.sign(f.obvSlope10) * 0.02);
  const base = (f.atrPct || 0.01) * (1 + 0.25 * absScore + flowKick);
  return clamp(base, 0.002, 0.08);
}

/* ========================= Public API ========================= */
function scoreWithRows(rows, cfg = {}) {
  const f = computeIndicators(rows, cfg);
  if (!(f.priceOk && f.liqOkUSD)) {
    return {
      in_universe: false,
      reason: 'universe_fail',
      indicators: f,
      decision: { final: 'Neutral', score: 0 },
      probability: { pUp: 0.5, magnitude: 0 }
    };
  }
  const decision = decideFromIndicators(f);
  const pUp = scoreToProbability(decision.score, CONFIG.TEMP);
  const magnitude = expectedMagnitude(f, decision.score);
  return {
    in_universe: true,
    indicators: f,
    decision,
    probability: { pUp, magnitude }
  };
}

/* ========================= Regression Head ========================= */
// Ridge regression: y = X w, with w = (X^T X + lambda I)^{-1} X^T y
// Features: zS, z_dS, z_dHist, logRV, z_dLogRV, obvSlope10/scale, z_obvSl, K, pctB, CLV, atrPct, z_ATRPct, BBW, z_dBBW, gapNorm, fill

function featureVectorFromIndicators(f) {
  return [
    f.zS, f.z_dS, f.z_dHist,
    f.logRV, f.z_dLogRV,
    Math.tanh(f.obvSlope10 / 1e9), f.z_obvSl,
    f.K, f.pctB, f.CLV,
    f.atrPct, f.z_ATRPct,
    f.BBW, f.z_dBBW,
    f.gapNorm, f.fill
  ];
}

function buildDatasetFromRows(rows, cfg = {}) {
  // Build samples for t = 40..n-2 (predict r_{t+1})
  const samples = [];
  for (let i = 40; i < rows.length - 1; i++) {
    const slice = rows.slice(0, i + 1);
    try {
      const f = computeIndicators(slice, cfg);
      if (!(f.priceOk && f.liqOkUSD)) continue;
      const x = featureVectorFromIndicators(f);
      const r = Math.log(rows[i + 1].close / rows[i].close); // next-day log return
      samples.push({ x, y: r });
    } catch { /* skip */ }
  }
  return samples;
}

function standardizeXY(samples) {
  const X = samples.map(s => s.x);
  const y = samples.map(s => s.y);
  const d = X[0].length;
  const means = Array(d).fill(0).map((_,j)=> mean(X.map(r=>r[j])));
  const stds  = Array(d).fill(0).map((_,j)=> stdev(X.map(r=>r[j])) || 1);
  const Xn = X.map(row => row.map((v,j)=> (v - means[j]) / stds[j]));
  const yn = y; // y stays raw (small numbers)
  return { X: Xn, y: yn, means, stds };
}

async function ridgeFit(X, y, lambda = 1e-2) {
  // X: Nxd, y: Nx1
  const Xt = tf.tensor2d(X);
  const yt = tf.tensor2d(y, [y.length, 1]);
  const d = X[0].length;
  const I = tf.eye(d);
  const XtX = Xt.transpose().matMul(Xt);
  const XtXlam = XtX.add(I.mul(lambda));
  const XtY = Xt.transpose().matMul(yt);
  const w = tf.linalg.pinv(XtXlam).matMul(XtY); // d x 1
  const wArr = await w.array();
  tf.dispose([Xt, yt, I, XtX, XtXlam, XtY, w]);
  return wArr.map(r => r[0]);
}

let REG = { loaded: false, w: null, means: null, stds: null, lambda: 1e-2 };

function saveModelToDisk(fsPath = 'model/sci_v1_regression.json') {
  const fs = require('fs');
  const dir = fsPath.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fsPath, JSON.stringify({ w: REG.w, means: REG.means, stds: REG.stds, lambda: REG.lambda }, null, 2));
}

function loadModelFromDisk(fsPath = 'model/sci_v1_regression.json') {
  try {
    const fs = require('fs');
    if (!fs.existsSync(fsPath)) return false;
    const j = JSON.parse(fs.readFileSync(fsPath, 'utf8'));
    REG = { loaded: true, ...j };
    return true;
  } catch { return false; }
}

async function trainRegressionForRows(rows, cfg = {}, lambda = 1e-2) {
  const samples = buildDatasetFromRows(rows, cfg);
  if (samples.length < 200) throw new Error('not enough samples to train');
  const { X, y, means, stds } = standardizeXY(samples);
  const w = await ridgeFit(X, y, lambda);
  REG = { loaded: true, w, means, stds, lambda };
  return { n: samples.length, d: w.length, lambda, w };
}

function predictReturnFromIndicators(f) {
  if (!REG.loaded || !REG.w) return null;
  const x = featureVectorFromIndicators(f);
  const xn = x.map((v, j) => (v - REG.means[j]) / (REG.stds[j] || 1));
  const r = xn.reduce((s, v, j) => s + v * REG.w[j], 0);
  return r; // predicted next-day log return
}

module.exports = {
  computeIndicators,
  decideFromIndicators,
  scoreWithRows,
  // prob & magnitude helpers (exported for parity with short-term model)
  scoreToProbability,
  expectedMagnitude,
  // regression (single-symbol)
  trainRegressionForRows,
  predictReturnFromIndicators,
  saveModelToDisk,
  loadModelFromDisk,
  // expose helpers for multi-symbol training
  buildDatasetFromRows,
  featureVectorFromIndicators,
  standardizeXY,
  ridgeFit
};

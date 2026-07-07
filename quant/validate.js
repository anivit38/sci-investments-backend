// validate.js — Stage 4: VALIDATE (§6)
//
// Walk-forward only — never k-fold (k-fold shuffles time and leaks the
// future, per §6.1). V1 [OWNER-SET]: this is a STATISTICAL CALIBRATION TEST
// of the quant layer's OWN pDown output (not a directional hit-rate on the
// existing decision score) — validates whether "when the model says pDown =
// 30%, does a down outcome actually happen ~30% of the time historically."
//
// At each walk-forward point t, Model A is re-run using only data available
// up to t (a smaller path count than the live N=10,000 — see modelA.js's
// simulateModelA — for tractability across dozens of retrospective folds;
// this doesn't change the locked live-request path count, only the cost of
// this specific retrospective test) to get a predicted pDown, then checked
// against what actually happened at t+15.
//
// Purge/embargo (§6.2): consecutive test points are spaced by
// HORIZON_DAYS + EMBARGO_DAYS (20 days) so no two folds' 15-day outcome
// windows overlap (purge=14) with an explicit 5-day buffer beyond that
// (embargo=5).

const { volRegime } = require('../services/regimeModel');
const { simulateModelA } = require('./modelA');
const { wilsonInterval } = require('./mathUtils');
const cfg = require('./ownerConfig');

const HORIZON_DAYS = 15;
const PURGE_DAYS = HORIZON_DAYS - 1; // 14, per §6.2 (H-1)
const EMBARGO_DAYS = 5;              // per §6.2
const STRIDE_DAYS = HORIZON_DAYS + EMBARGO_DAYS; // 20
const MIN_ROWS_FOR_FOLD = 90; // needs enough for volRegime's own windowing + a meaningful dailyStates read
const FOLD_N_PATHS = 500; // retrospective-test-only path count, see module note above

function runFold(rows, closes, t) {
  const trainCloses = closes.slice(0, t + 1);
  if (trainCloses.length < MIN_ROWS_FOR_FOLD) return null;
  const outcomeIdx = t + HORIZON_DAYS;
  if (outcomeIdx >= rows.length) return null;

  const logRet = [];
  for (let i = 1; i < trainCloses.length; i++) logRet.push(Math.log(trainCloses[i] / trainCloses[i - 1]));

  let vr;
  try {
    vr = volRegime(logRet);
  } catch {
    return null;
  }
  if (!Array.isArray(vr.dailyStates) || vr.dailyStates.length < 30) return null;

  let predicted;
  try {
    predicted = simulateModelA({
      logRet, vr, currentPrice: rows[t].close, nPaths: FOLD_N_PATHS, seed: 1000 + t, keepPaths: 0,
    }).pDown;
  } catch {
    return null;
  }

  const actualDown = rows[outcomeIdx].close < rows[t].close ? 1 : 0;
  return { predicted, actualDown, t };
}

// Bins predictions into cfg.V1_BIN_EDGES buckets and, per bin, checks whether
// the bin's mean predicted probability falls within the Wilson confidence
// interval of the bin's OBSERVED down-frequency (§6.4's "check observed
// frequencies fall within the test's confidence intervals").
function calibrationTest(folds) {
  const edges = cfg.V1_BIN_EDGES;
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], preds: [], actuals: [] }));

  for (const f of folds) {
    const bin = bins.find(b => f.predicted >= b.lo && f.predicted < b.hi) || bins[bins.length - 1];
    bin.preds.push(f.predicted);
    bin.actuals.push(f.actualDown);
  }

  const totalSamples = folds.length;
  const binResults = bins.map(b => {
    const n = b.actuals.length;
    if (n === 0) return { range: [b.lo, b.hi], n: 0, evaluated: false };
    const meanPredicted = b.preds.reduce((a, x) => a + x, 0) / n;
    const successes = b.actuals.reduce((a, x) => a + x, 0);
    const observedFreq = successes / n;
    if (n < cfg.V1_MIN_SAMPLES_PER_BIN) {
      return { range: [b.lo, b.hi], n, evaluated: false, meanPredicted: +meanPredicted.toFixed(3), observedFreq: +observedFreq.toFixed(3) };
    }
    const [lo, hi] = wilsonInterval(successes, n, cfg.V1_CONFIDENCE_Z);
    const withinCI = meanPredicted >= lo && meanPredicted <= hi;
    return {
      range: [b.lo, b.hi], n, evaluated: true,
      meanPredicted: +meanPredicted.toFixed(3), observedFreq: +observedFreq.toFixed(3),
      ci: [+lo.toFixed(3), +hi.toFixed(3)], withinCI,
    };
  });

  const evaluated = binResults.filter(b => b.evaluated);
  let calibration;
  if (totalSamples < cfg.V1_MIN_TOTAL_SAMPLES || evaluated.length === 0) {
    calibration = 'unknown';
  } else {
    calibration = evaluated.every(b => b.withinCI) ? 'ok' : 'failed';
  }

  return { calibration, bins: binResults, totalSamples };
}

/**
 * Runs the full walk-forward + locked-holdout calibration backtest. Kept off
 * the request's blocking path by the caller (quant/index.js) per §6.5.
 * @param {Array} rows - chronological {date, open, high, low, close, volume}
 */
function runValidation(rows) {
  const closes = rows.map(r => r.close);
  const firstTestIdx = MIN_ROWS_FOR_FOLD - 1;
  const lastTestIdx = rows.length - 1 - HORIZON_DAYS;

  const testPoints = [];
  for (let t = firstTestIdx; t <= lastTestIdx; t += STRIDE_DAYS) testPoints.push(t);

  // Locked hold-out (§6.1): the most recent ~20% of fold points, opened once,
  // never used to tune anything.
  const holdoutCount = Math.max(1, Math.round(testPoints.length * 0.2));
  const inSamplePoints = testPoints.slice(0, testPoints.length - holdoutCount);
  const holdoutPoints = testPoints.slice(testPoints.length - holdoutCount);

  const inSampleFolds = inSamplePoints.map(t => runFold(rows, closes, t)).filter(Boolean);
  const holdoutFolds = holdoutPoints.map(t => runFold(rows, closes, t)).filter(Boolean);

  const inSampleResult = calibrationTest(inSampleFolds);
  const holdoutResult = calibrationTest(holdoutFolds);

  return {
    purgeDays: PURGE_DAYS,
    embargoDays: EMBARGO_DAYS,
    strideDays: STRIDE_DAYS,
    calibration: inSampleResult.calibration,
    bins: inSampleResult.bins,
    folds: inSampleResult.totalSamples,
    holdout: { calibration: holdoutResult.calibration, folds: holdoutResult.totalSamples },
  };
}

module.exports = { runValidation, HORIZON_DAYS, PURGE_DAYS, EMBARGO_DAYS, STRIDE_DAYS };

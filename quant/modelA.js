// modelA.js — Model A: HMM-transition, regime-conditioned Monte Carlo (§3, Model A)
//
// Reuses the existing regime model (services/regimeModel.js — Hurst + 2-state
// vol regime) rather than fitting a new one. There is no pre-existing fitted
// HMM transition matrix anywhere in SCI (see notes in regimeModel.js), so the
// day-to-day transition matrix used here is an EMPIRICAL transition-frequency
// count derived directly from the existing regime classifier's own
// day-by-day labels (dailyStates) — the most literal possible interpretation
// of "reuse the existing regime model," not a new statistical model.
//
// A1 [OWNER-SET]: the orchestrator (quant/index.js) enforces the ~400-day
// minimum-history gate BEFORE this module is ever called — if there isn't
// enough history, the quant layer doesn't run at all (no partial model, no
// degraded fallback here). This module can assume adequate history.

const { makeRng, randNormal, mean, stdev } = require('./mathUtils');

const N_PATHS = 10000; // §2, locked
const HORIZON_DAYS = 15; // §2, locked

function splitByRegime(logRet, dailyStates) {
  // dailyStates is shorter than logRet by the 20-day vol window used to
  // compute it; align to the tail of logRet.
  const offset = logRet.length - dailyStates.length;
  const buckets = { 'high-vol': [], 'low-vol': [] };
  for (let i = 0; i < dailyStates.length; i++) {
    const ret = logRet[offset + i];
    if (ret != null && Number.isFinite(ret)) buckets[dailyStates[i]].push(ret);
  }
  return buckets;
}

function empiricalTransitionMatrix(dailyStates) {
  const counts = {
    'high-vol': { 'high-vol': 0, 'low-vol': 0 },
    'low-vol':  { 'high-vol': 0, 'low-vol': 0 },
  };
  for (let i = 1; i < dailyStates.length; i++) {
    const prev = dailyStates[i - 1], cur = dailyStates[i];
    counts[prev][cur] += 1;
  }
  const matrix = {};
  for (const from of ['high-vol', 'low-vol']) {
    const total = counts[from]['high-vol'] + counts[from]['low-vol'];
    matrix[from] = total > 0
      ? { 'high-vol': counts[from]['high-vol'] / total, 'low-vol': counts[from]['low-vol'] / total }
      : { 'high-vol': 0.5, 'low-vol': 0.5 }; // never-observed transition — coin flip
  }
  return matrix;
}

/**
 * Core simulation, parameterized by path count so validate.js's calibration
 * folds can reuse the exact same model at a cheaper N for retrospective
 * testing (§6.4) while live stock-checks always use the locked N=10,000.
 *
 * @param {object} params
 * @param {number[]} params.logRet - historical daily log returns
 * @param {object} params.vr - output of regimeModel.volRegime(logRet) (has .regime, .dailyStates)
 * @param {number} params.currentPrice - last known price, path levels are expressed in this unit
 * @param {number} [params.nPaths]
 * @param {number} [params.seed]
 * @param {number} [params.keepPaths] - how many full sample paths to retain for charting
 */
function simulateModelA({ logRet, vr, currentPrice, nPaths = N_PATHS, seed = 42, keepPaths = 40 }) {
  const rng = makeRng(seed);
  const dailyStates = Array.isArray(vr?.dailyStates) ? vr.dailyStates : [];
  const currentRegime = vr?.regime === 'high-vol' ? 'high-vol' : 'low-vol';

  const buckets = splitByRegime(logRet, dailyStates);
  const regimeParams = {
    'high-vol': { mu: mean(buckets['high-vol']), sigma: stdev(buckets['high-vol']) || stdev(logRet) || 0.01 },
    'low-vol':  { mu: mean(buckets['low-vol']),  sigma: stdev(buckets['low-vol'])  || stdev(logRet) || 0.01 },
  };
  const transitionMatrix = empiricalTransitionMatrix(dailyStates);

  const terminalReturns = new Array(nPaths);
  const maxDrawdowns = new Array(nPaths);
  const samplePaths = [];

  for (let p = 0; p < nPaths; p++) {
    let regime = currentRegime;
    let level = currentPrice;
    let peak = level;
    let worstDD = 0;
    const keepPath = p < keepPaths;
    const levels = keepPath ? [level] : null;

    for (let d = 0; d < HORIZON_DAYS; d++) {
      // switch regime for this day per the transition matrix
      const trans = transitionMatrix[regime];
      regime = rng() < trans['high-vol'] ? 'high-vol' : 'low-vol';
      const { mu, sigma } = regimeParams[regime];
      const r = mu + sigma * randNormal(rng);
      level = level * Math.exp(r);
      if (level > peak) peak = level;
      const dd = (peak - level) / peak;
      if (dd > worstDD) worstDD = dd;
      if (keepPath) levels.push(level);
    }

    terminalReturns[p] = level / currentPrice - 1;
    maxDrawdowns[p] = worstDD;
    if (keepPath) samplePaths.push(levels);
  }

  const pDown = terminalReturns.filter(r => r < 0).length / nPaths;

  return {
    model: 'A',
    pDown,
    terminalReturns,
    maxDrawdowns,
    samplePaths,
    regimeParams,
    transitionMatrix,
    nPaths,
    horizonDays: HORIZON_DAYS,
  };
}

function runModelA({ logRet, vr, currentPrice, seed = 42 }) {
  return simulateModelA({ logRet, vr, currentPrice, nPaths: N_PATHS, seed, keepPaths: 40 });
}

module.exports = { runModelA, simulateModelA, N_PATHS, HORIZON_DAYS };

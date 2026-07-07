// characterize.js — Stage 2: CHARACTERIZE (§4)
// Reads the terminal distributions from both models and produces the verdict.

const { percentile } = require('./mathUtils');
const cfg = require('./ownerConfig');
const universeCache = require('./universeCache');

// §4.4 model-disagreement penalty — soft ramp starting at the 15pt trigger.
// C1 [OWNER-SET]: dock = (disagreement - 15) * 0.5, floored at 0. A 40pt gap
// docks ~12.5 points, matching the spec's own worked example.
function confidenceDock(disagreementPts) {
  if (disagreementPts <= cfg.C1_RAMP_START_PTS) return 0;
  return +((disagreementPts - cfg.C1_RAMP_START_PTS) * cfg.C1_DOCK_SLOPE).toFixed(1);
}

// §4.3 drawdown flag — D1 [OWNER-SET]: 95th percentile of per-path max
// drawdown, pooled across both models' paths; "notable" above 15%. The
// optional "severe" tier (ownerConfig.D1_SEVERE_PCT_OPTIONAL) is off unless
// explicitly enabled later — see ownerConfig.js.
function drawdownFlag(maxDrawdownsA, maxDrawdownsB) {
  const all = [...maxDrawdownsA, ...maxDrawdownsB].sort((a, b) => a - b);
  const value = percentile(all, cfg.D1_PERCENTILE);
  const valuePct = +(value * 100).toFixed(1);
  let level = 'none';
  if (cfg.D1_SEVERE_PCT_OPTIONAL != null && valuePct >= cfg.D1_SEVERE_PCT_OPTIONAL) level = 'severe';
  else if (valuePct >= cfg.D1_NOTABLE_PCT) level = 'notable';
  return { level, p95MaxDrawdown: valuePct };
}

/**
 * @param {object} resultA - output of modelA.runModelA
 * @param {object} resultB - output of modelB.runModelB
 * @param {string} sector - assetProfile.sector (or industry fallback), for the G1 sector-relative median
 */
function characterize(resultA, resultB, sector) {
  const pDown_A = resultA.pDown;
  const pDown_B = resultB.pDown;

  // G2 [OWNER-SET]: Model A's pDown is the gated value. Model B never enters
  // the pass/fail decision — only §4.4's disagreement/confidence math below.
  const pDown_gated = pDown_A;

  // G1 [OWNER-SET]: sector-relative median, thin-sector (<8) fallback to
  // whole-universe median.
  const { median: thresholdMedian, n: sectorN, usedFallback, universeN } = universeCache.getMedianFor(sector);
  const passesGate = pDown_gated <= thresholdMedian;

  const disagreementPts = +(Math.abs(pDown_A - pDown_B) * 100).toFixed(1);
  const dock = confidenceDock(disagreementPts);

  const drawdown = drawdownFlag(resultA.maxDrawdowns, resultB.maxDrawdowns);

  return {
    verdict: passesGate ? 'pass' : 'fail', // may still be downgraded by Stage 3/4
    pDown: { modelA: +pDown_A.toFixed(4), modelB: +pDown_B.toFixed(4), gatedValue: +pDown_gated.toFixed(4) },
    thresholdMedian,
    sectorRelative: !usedFallback,
    sectorSampleSize: sectorN,
    universeSampleSize: universeN,
    drawdownFlag: drawdown,
    modelAgreement: {
      disagreementPts,
      confidenceDock: dock,
    },
  };
}

module.exports = { characterize, confidenceDock, drawdownFlag };

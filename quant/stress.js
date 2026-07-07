// stress.js — Stage 3: STRESS (§5)
// Applies all three stress approaches and downgrades (never hard-vetoes) on failure.

const { makeRng, randNormal } = require('./mathUtils');
const { episodeReturns } = require('./historicalFetch');
const cfg = require('./ownerConfig');

const STRESS_N_PATHS = 2000; // supplementary scenarios — smaller N than the main 10,000, compute-bounded
const HORIZON_DAYS = 15;

// Runs a regime-conditioned simulation like Model A, but pinned into a
// specific starting condition (used for gap-down, vol-multiplier, and
// regime-forced scenarios) rather than the natural transition dynamics.
function simulateFrom({ currentPrice, regimeParams, transitionMatrix, startRegime, volMultiplier = 1, seed }) {
  const rng = makeRng(seed);
  const terminalReturns = new Array(STRESS_N_PATHS);
  for (let p = 0; p < STRESS_N_PATHS; p++) {
    let regime = startRegime;
    let level = currentPrice;
    for (let d = 0; d < HORIZON_DAYS; d++) {
      const trans = transitionMatrix[regime];
      regime = rng() < trans['high-vol'] ? 'high-vol' : 'low-vol';
      const { mu, sigma } = regimeParams[regime];
      const r = mu + (sigma * volMultiplier) * randNormal(rng);
      level = level * Math.exp(r);
    }
    terminalReturns[p] = level / currentPrice - 1;
  }
  return terminalReturns;
}

function pDownOf(terminalReturns) {
  return terminalReturns.filter(r => r < 0).length / terminalReturns.length;
}

// §5.1 historical replay. S1 [OWNER-SET]: 2008 GFC / 2020 COVID / 2022 rate
// shock, replayed as the STOCK'S OWN actual historical return sequence
// during each window (not a market-index proxy, not a synthetic shock).
//
// Historical replay is deterministic (one real sequence, not a distribution)
// so it has no "pDown" of its own. To apply the same "crosses the median"
// fail-line mechanism from §5.4 uniformly across all stress types, ending
// the replay below break-even is treated as the deterministic equivalent of
// pDown=100% for the fail comparison — i.e. it fails whenever the stock's
// own real returns during that crisis would have put it underwater by day 15.
function historicalReplay(currentPrice, extendedHistory) {
  const episodes = cfg.S1_EPISODES.map(ep => {
    const rets = episodeReturns(extendedHistory, ep.start, ep.end);
    if (!rets) {
      return { episode: ep.name, applicable: false, terminalReturn: null, failed: false };
    }
    // Chain the ACTUAL historical return sequence for this episode onto the
    // stock's current price; if the episode ran longer than the 15-day
    // horizon, read the terminal outcome at day 15 (consistent with §2's
    // "terminal" verdict basis), not the full episode's cumulative move.
    const path = rets.slice(0, HORIZON_DAYS);
    let level = currentPrice;
    for (const r of path) level *= Math.exp(r);
    const terminalReturn = level / currentPrice - 1;
    return {
      episode: ep.name,
      applicable: true,
      daysReplayed: path.length,
      terminalReturn: +terminalReturn.toFixed(4),
      failed: terminalReturn < 0,
    };
  });
  const applicableFailures = episodes.filter(e => e.applicable && e.failed).length;
  return { episodes, failed: applicableFailures > 0 };
}

// §5.2 hypothetical shocks (LOCKED magnitudes). Fail-line (S2 [OWNER-SET]):
// stressed pDown crosses the sector-relative median (the same
// `thresholdMedian` computed in characterize.js — see the note at the call
// site in quant/index.js for why "current" is the only median obtainable).
function hypotheticalShocks({ currentPrice, regimeParams, transitionMatrix, startRegime, thresholdMedian }) {
  const scenarios = [
    { name: 'gap_down_7pct',  gap: -0.07 },
    { name: 'gap_down_15pct', gap: -0.15 },
  ];
  const gapResults = scenarios.map((s, i) => {
    const gappedPrice = currentPrice * Math.exp(s.gap);
    const terminalReturns = simulateFrom({
      currentPrice: gappedPrice, regimeParams, transitionMatrix, startRegime,
      seed: 9001 + i,
    });
    const pDown = pDownOf(terminalReturns);
    return { name: s.name, gapPct: s.gap * 100, pDown: +pDown.toFixed(4), failed: pDown > thresholdMedian };
  });

  const volTerminal = simulateFrom({
    currentPrice, regimeParams, transitionMatrix, startRegime,
    volMultiplier: 2.5, seed: 9101,
  });
  const volPDown = pDownOf(volTerminal);
  const volResult = { name: 'vol_x2.5', pDown: +volPDown.toFixed(4), failed: volPDown > thresholdMedian };

  return { gapDown: gapResults, volMultiplier: volResult };
}

// §5.3 regime-forced shock — force the worst detected regime (high-vol, by
// construction the higher-variance component) for the whole horizon.
function regimeForcedShock({ currentPrice, regimeParams, transitionMatrix, thresholdMedian }) {
  const forcedMatrix = { 'high-vol': { 'high-vol': 1, 'low-vol': 0 }, 'low-vol': { 'high-vol': 1, 'low-vol': 0 } };
  const terminalReturns = simulateFrom({
    currentPrice, regimeParams, transitionMatrix: forcedMatrix, startRegime: 'high-vol', seed: 9201,
  });
  const pDown = pDownOf(terminalReturns);
  return { pDown: +pDown.toFixed(4), failed: pDown > thresholdMedian };
}

/**
 * @param {object} params
 * @param {number} params.currentPrice
 * @param {object} params.regimeParams - from modelA result
 * @param {object} params.transitionMatrix - from modelA result
 * @param {string} params.currentRegime
 * @param {number} params.thresholdMedian - the sector-relative median from characterize.js (§4.2), reused here for §5.4's fail-line
 * @param {object} params.extendedHistory - from historicalFetch.getExtendedHistory(symbol)
 */
function runStress({ currentPrice, regimeParams, transitionMatrix, currentRegime, thresholdMedian, extendedHistory }) {
  const historical = historicalReplay(currentPrice, extendedHistory);
  const hypothetical = hypotheticalShocks({ currentPrice, regimeParams, transitionMatrix, startRegime: currentRegime, thresholdMedian });
  const regimeForced = regimeForcedShock({ currentPrice, regimeParams, transitionMatrix, thresholdMedian });

  const anyFailed =
    historical.failed ||
    hypothetical.gapDown.some(g => g.failed) ||
    hypothetical.volMultiplier.failed ||
    regimeForced.failed;

  // S2 [OWNER-SET]: a single flat 10-point downgrade if ANY scenario failed
  // (not multiplied per failing scenario), plus the honest historical/
  // probabilistic message — never a hard veto, never phrased as certainty.
  const downgrade = anyFailed ? cfg.S2_DOWNGRADE_FLAT : 0;

  return {
    historical,
    hypothetical,
    regimeForced,
    result: anyFailed ? 'downgraded' : 'ok',
    confidenceDowngrade: downgrade,
    message: anyFailed ? cfg.S2_MESSAGE : null,
  };
}

module.exports = { runStress };

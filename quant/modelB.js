// modelB.js — Model B: plain block bootstrap (§3, Model B)
//
// Deliberately regime-blind — this model must NOT read the regime model at
// all. Its entire value is being an independent witness to Model A; making
// it regime-aware would destroy that independence (locked design choice in
// the spec). Resamples contiguous blocks of real historical returns (to
// preserve short-run autocorrelation) and stitches them into 15-day paths.
//
// B1 [OWNER-SET]: 10-trading-day blocks, drawn from a trailing 5-year
// history window (ownerConfig.B1_BLOCK_SIZE_DAYS / B1_HISTORY_WINDOW_DAYS).
// The 5-year series is fetched independently by quant/historicalFetch.js
// (the existing pipeline's own historicalRows only covers ~2 years and must
// not be touched — prime directive #1).

const { makeRng } = require('./mathUtils');
const cfg = require('./ownerConfig');

const N_PATHS = 10000; // §2, locked
const HORIZON_DAYS = 15; // §2, locked

/**
 * @param {object} params
 * @param {number[]} params.logRet - log returns from the extended (up to 5yr) history window
 * @param {number} params.currentPrice
 * @param {number} [params.seed]
 */
function runModelB({ logRet, currentPrice, seed = 1337 }) {
  const blockSize = cfg.B1_BLOCK_SIZE_DAYS;
  const windowDays = Math.min(cfg.B1_HISTORY_WINDOW_DAYS, logRet.length);
  const pool = logRet.slice(-windowDays);

  const rng = makeRng(seed);
  const maxStart = pool.length - blockSize;
  function drawBlock() {
    if (maxStart <= 0) return pool; // degenerate (shouldn't happen once the A1 400-day gate has passed)
    const start = Math.floor(rng() * (maxStart + 1));
    return pool.slice(start, start + blockSize);
  }

  const terminalReturns = new Array(N_PATHS);
  const maxDrawdowns = new Array(N_PATHS);
  const samplePaths = [];

  for (let p = 0; p < N_PATHS; p++) {
    let level = currentPrice;
    let peak = level;
    let worstDD = 0;
    const keepPath = p < 40;
    const levels = keepPath ? [level] : null;

    let daysFilled = 0;
    while (daysFilled < HORIZON_DAYS) {
      const block = drawBlock();
      const remaining = HORIZON_DAYS - daysFilled;
      const slice = block.length > remaining ? block.slice(0, remaining) : block;
      for (const r of slice) {
        level = level * Math.exp(r);
        if (level > peak) peak = level;
        const dd = (peak - level) / peak;
        if (dd > worstDD) worstDD = dd;
        if (keepPath) levels.push(level);
      }
      daysFilled += slice.length;
      if (slice.length === 0) break; // guard against an empty pool
    }

    terminalReturns[p] = level / currentPrice - 1;
    maxDrawdowns[p] = worstDD;
    if (keepPath) samplePaths.push(levels);
  }

  const pDown = terminalReturns.filter(r => r < 0).length / N_PATHS;

  return {
    model: 'B',
    pDown,
    terminalReturns,
    maxDrawdowns,
    samplePaths,
    blockSize,
    windowDays: pool.length,
    nPaths: N_PATHS,
    horizonDays: HORIZON_DAYS,
  };
}

module.exports = { runModelB, N_PATHS, HORIZON_DAYS };

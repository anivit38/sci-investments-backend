// mathUtils.js — small deterministic-seedable helpers shared by both path models.

// Mulberry32 PRNG — deterministic given a seed, fast, good enough for MC sims.
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller standard normal sample using a supplied uniform RNG.
function randNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
}

// Linear-interpolated percentile, p in [0,1].
function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = p * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const frac = idx - lo;
  return sortedArr[lo] * (1 - frac) + sortedArr[hi] * frac;
}

// Max drawdown along a single path of price levels (not returns).
function maxDrawdown(levels) {
  let peak = levels[0];
  let worst = 0;
  for (const lvl of levels) {
    if (lvl > peak) peak = lvl;
    const dd = (peak - lvl) / peak;
    if (dd > worst) worst = dd;
  }
  return worst; // fraction, e.g. 0.18 = 18%
}

// Bins a large sample array into `bins` equal-width buckets. Returns compact
// {edges, counts} — used so raw 10,000-length simulation arrays never have to
// leave the server (prime directive #2: frontend gets only finished results).
function histogram(values, bins = 24) {
  if (!values.length) return { edges: [], counts: [] };
  const lo = Math.min(...values), hi = Math.max(...values);
  const width = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - lo) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  const edges = new Array(bins + 1).fill(0).map((_, i) => +(lo + i * width).toFixed(4));
  return { edges, counts };
}

// Wilson score interval for a binomial proportion — used by the V1
// calibration test (quant/validate.js) to check whether a bin's predicted
// probability falls within the confidence interval of its observed
// down-frequency.
// @param {number} successes - count of "down" outcomes in the bin
// @param {number} n - total observations in the bin
// @param {number} z - critical value (e.g. 1.645 for ~90% two-sided)
function wilsonInterval(successes, n, z) {
  if (n === 0) return [0, 1];
  const pHat = successes / n;
  const denom = 1 + (z * z) / n;
  const center = pHat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

module.exports = { makeRng, randNormal, mean, stdev, percentile, maxDrawdown, histogram, wilsonInterval };

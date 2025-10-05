// sci-formula-engine.js
// Implements your SCI Master Formula rules without inventing any new thresholds or weights.
// Drop-in Node module. Pure functions, testable. No I/O or DB.

/**
 * Dependencies: none (uses built-in JS)
 * If you prefer, swap to lodash for quantile helpers.
 */

// ---------- Math helpers ----------
const eps = 1e-12;

function median(arr) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

function mad(arr) {
  if (!arr.length) return NaN;
  const med = median(arr);
  const dev = arr.map((x) => Math.abs(x - med));
  // Consistent MAD (scale to std for normal): 1.4826 * median(|x - med|)
  return 1.4826 * median(dev);
}

function winsorize(arr, limit = 3.5) {
  return arr.map((z) => Math.max(-limit, Math.min(limit, z)));
}

// Rolling median/MAD z-score over lookback L, excluding current index
function rollingRobustZ(values, L, { winsorFinal = true } = {}) {
  const n = values.length;
  const z = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    const start = Math.max(0, t - L);
    const end = t; // exclude t
    if (end - start <= 1) continue;
    const window = values.slice(start, end);
    // Optional: outlier policy for group stats: exclude |z|>3.5 before med/MAD.
    // We implement a robust two-pass: compute med/MAD, drop gross outliers, recompute.
    let med1 = median(window);
    let mad1 = mad(window);
    const filtered = mad1 > eps ? window.filter((x) => Math.abs((x - med1) / mad1) <= 3.5) : window;
    const med2 = median(filtered);
    const mad2 = mad(filtered);
    if (mad2 <= eps) continue; // undefined when dispersion ~0
    z[t] = (values[t] - med2) / mad2;
  }
  return winsorFinal ? winsorize(z, 3.5) : z;
}

// ---------- Labeling helpers ----------
// Up/Down labels are next-day direction vs today's close
function nextDayUpLabels(close) {
  const n = close.length;
  const labs = new Array(n).fill(null);
  for (let t = 0; t < n - 1; t++) {
    const up = close[t + 1] > close[t];
    labs[t] = up ? 'Up' : 'Down';
  }
  labs[n - 1] = null; // unknown
  return labs;
}

// Baseline b over a validation window [vStart, vEnd)
function baselineUpRate(labels, vStart, vEnd) {
  let up = 0, tot = 0;
  for (let i = vStart; i < vEnd; i++) {
    if (labels[i] == null) continue;
    tot++;
    if (labels[i] === 'Up') up++;
  }
  return tot > 0 ? up / tot : NaN;
}

// ---------- Equal-frequency deciles (left-closed) ----------
function decileCutpoints(scores, vStart, vEnd) {
  const slice = scores.slice(vStart, vEnd).filter((x) => Number.isFinite(x));
  const n = slice.length;
  if (n === 0) return [];
  const sorted = [...slice].sort((a, b) => a - b);
  const cuts = [];
  for (let k = 1; k <= 9; k++) {
    const i = Math.ceil((k * n) / 10);
    cuts.push(sorted[Math.min(i - 1, n - 1)]);
  }
  return cuts; // c1..c9
}

function decileIndex(x, cuts) {
  // Left-closed: D1=(-inf,c1], D2=(c1,c2],...,D10=(c9,inf)
  for (let k = 0; k < cuts.length; k++) {
    if (x <= cuts[k]) return k; // 0..8
  }
  return 9; // last bin
}

// ---------- Neighborhood empirical probability in z-units ----------
function empiricalPUpAtS(scores, labels, s, vStart, vEnd, { width = 1, minN = 45 }) {
  let up = 0, tot = 0;
  for (let i = vStart; i < vEnd; i++) {
    const sc = scores[i];
    const lab = labels[i];
    if (!Number.isFinite(sc) || lab == null) continue;
    if (Math.abs(sc - s) < width) {
      tot++;
      if (lab === 'Up') up++;
    }
  }
  if (tot < minN) return { pUp: NaN, n: tot };
  return { pUp: up / tot, n: tot };
}

// ---------- Action rules ----------
function actionFromPUp(pUp, baseline, relMargin = 0.10) {
  if (!Number.isFinite(pUp) || !Number.isFinite(baseline)) return 'Neutral';
  if (pUp >= (1 + relMargin) * baseline) return 'Bull';
  if (pUp <= (1 - relMargin) * baseline) return 'Bear';
  return 'Neutral';
}

// ---------- %SM per group and average across groups ----------
function percentSameMovement(labelsInGroup) {
  const ups = labelsInGroup.filter((x) => x === 'Up').length;
  const downs = labelsInGroup.filter((x) => x === 'Down').length;
  const n = ups + downs;
  if (n === 0) return NaN;
  return Math.max(ups, downs) / n; // majority share
}

function avgPercentSameMovementByBins(scores, labels, cuts, vStart, vEnd) {
  const groups = Array.from({ length: 10 }, () => []);
  for (let i = vStart; i < vEnd; i++) {
    const s = scores[i];
    const lab = labels[i];
    if (!Number.isFinite(s) || lab == null) continue;
    const d = decileIndex(s, cuts);
    groups[d].push(lab);
  }
  const percs = groups.map(percentSameMovement);
  const valid = percs.filter((x) => Number.isFinite(x));
  if (!valid.length) return { avg: NaN, perGroup: percs };
  const avg = percs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) / percs.length; // include NaN as 0 as per spec incl. Neutral
  return { avg, perGroup: percs, groups };
}

// ---------- Combo selection & tie-breaker ----------
function averageMADForMajorityReturns(groups, returnsByIndex) {
  // groups: array[10] of label arrays aligned with validation indices (we’ll pass aligned returns)
  // returnsByIndex: function(idx)->next-day return
  const perGroupMAD = groups.map((labels) => {
    if (!labels.length) return NaN;
    const ups = labels.filter((x) => x === 'Up').length;
    const downs = labels.length - ups;
    const maj = ups >= downs ? 'Up' : 'Down';
    const rets = labels.map((lab, j) => {
      // We cannot reconstruct original indices here without extra bookkeeping; in engine usage,
      // pass pre-aligned arrays for returns to each group if you need exact tie-break MADs.
      return NaN;
    });
    return mad(rets.filter((x) => Number.isFinite(x)));
  });
  const valid = perGroupMAD.filter((x) => Number.isFinite(x));
  if (!valid.length) return NaN;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// ---------- High-level API ----------
/**
 * buildCompositeScore: combine z-scored metric components you supply.
 * We don’t invent weights; you pass a combiner callback.
 */
function buildCompositeScore(zMetricMap, combiner) {
  // zMetricMap: { name: zArray }
  // combiner: (zMetricMap, idx) => number
  const n = Object.values(zMetricMap)[0]?.length || 0;
  const S = new Array(n).fill(NaN);
  for (let t = 0; t < n; t++) {
    S[t] = combiner(zMetricMap, t);
  }
  return S;
}

/**
 * evaluateCombo: given composite scores S, closes, validation window, returns metrics per your spec.
 */
function evaluateCombo(S, close, vStart, vEnd, { neighborhoodWidth = 1, minN = 45, relMargin = 0.10 } = {}) {
  const labels = nextDayUpLabels(close);
  const b = baselineUpRate(labels, vStart, vEnd);

  // Neighborhood P_up(S_t) for each validation point
  const pUps = [];
  const actions = [];
  for (let i = vStart; i < vEnd; i++) {
    const s = S[i];
    if (!Number.isFinite(s) || labels[i] == null) { pUps.push(NaN); actions.push('Neutral'); continue; }
    const { pUp } = empiricalPUpAtS(S, labels, s, vStart, vEnd, { width: neighborhoodWidth, minN });
    pUps.push(pUp);
    actions.push(actionFromPUp(pUp, b, relMargin));
  }

  // Equal-frequency deciles from validation slice
  const cuts = decileCutpoints(S, vStart, vEnd);
  const { avg, perGroup, groups } = avgPercentSameMovementByBins(S, labels, cuts, vStart, vEnd);

  return {
    baseline: b,
    neighborhoodWidth,
    minN,
    relMargin,
    pUps,
    actions,
    decileCuts: cuts,
    avgPercentSameMovement: avg,
    perGroupPercentSameMovement: perGroup,
    groups, // label arrays by bin (validation slice)
  };
}

// === replace from here ===
function toChartTriples(S, close) {
  const n = Math.min(S.length, close.length);
  const out = [];
  for (let t = 0; t < n; t++) {
    const next = t + 1 < n ? close[t + 1] : null;
    const move = next == null ? null : (next > close[t] ? 'Up' : 'Down');
    const pctChange = next == null ? null : ((next - close[t]) / (close[t] || eps));
    out.push({ score: S[t], move, pctChange });
  }
  return out;
}

function rowsToCSV(rows, opts) {
  const header = (opts && Array.isArray(opts.header)) ? opts.header : ['SCORE', 'MOVE', '%CHANGE'];
  const lines = [];
  if (header) lines.push(header.join(','));
  for (const r of rows) {
    const s = Number.isFinite(r.score) ? r.score.toFixed(6) : '';
    const m = r.move == null ? '' : String(r.move);
    const p = Number.isFinite(r.pctChange) ? r.pctChange.toFixed(6) : '';
    lines.push([s, m, p].join(','));
  }
  return lines.join('\n');
}

// keep ONLY one export block in the file:
module.exports = {
  median,
  mad,
  winsorize,
  rollingRobustZ,
  nextDayUpLabels,
  baselineUpRate,
  decileCutpoints,
  decileIndex,
  empiricalPUpAtS,
  actionFromPUp,
  percentSameMovement,
  avgPercentSameMovementByBins,
  buildCompositeScore,
  evaluateCombo,
  toChartTriples,
  rowsToCSV,
};


/* ---------------- Example usage (pseudo) ----------------
const close = [...];
const rvol = [...];
const rsi = [...];
const L = 252;

const zRVOL = rollingRobustZ(rvol, L);
const zRSI = rollingRobustZ(rsi, L);

// You define the combiner (weights/logic are YOUR IP)
const S = buildCompositeScore({ zRVOL, zRSI }, (Z, t) => {
  return Number.NaN; // fill in with YOUR formula
});

const vStart = 1000, vEnd = close.length - 1;
const report = evaluateCombo(S, close, vStart, vEnd, { neighborhoodWidth: 1, minN: 45, relMargin: 0.10 });

// --- Produce chart table ---
const triples = toChartTriples(S, close);
const csv = rowsToCSV(triples);
// fs.writeFileSync('out/SCI_score_move_pct.csv', csv);
*/

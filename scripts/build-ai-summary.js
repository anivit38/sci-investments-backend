#!/usr/bin/env node
/**
 * build-ai-summary.js
 * Create a compact, privacy-safe summary of training data for an LLM.
 * No raw candles are sent anywhere — this only computes aggregate stats.
 *
 * Usage:
 *   node scripts/build-ai-summary.js --symbolsFile data/sp500.txt \
 *        --from 2020-01-01 --to 2025-09-01 --out tmp/ai_summary.json
 */

const fs = require('fs');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;
if (yahooFinance.suppressNotices) yahooFinance.suppressNotices(['ripHistorical']);

const { computeIndicators, featureVectorFromIndicators } =
  require('../services/sciV1Engine.js');

/* ---------------- CLI ---------------- */
// robust parser: supports --k=v and --k v
function parseArgs(argv) {
  const out = {};
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (!tok.startsWith('--')) continue;
    const body = tok.slice(2);
    if (body.includes('=')) {
      const [k, v] = body.split('=');
      out[k] = v;
    } else {
      const nxt = a[i + 1];
      if (nxt && !nxt.startsWith('--')) { out[body] = nxt; i++; }
      else out[body] = true;
    }
  }
  return out;
}
const args = parseArgs(process.argv);

const symbolsFile = args.symbolsFile || null;
const symbolsCSV  = args.symbols || null;
const fromStr = String(args.from || '2020-01-01').slice(0, 10);
const toStr   = String(args.to   || new Date().toISOString().slice(0, 10)).slice(0, 10);
const outPath = args.out || 'tmp/ai_summary.json';

/* -------------- symbols -------------- */
function parseSymbols(text) {
  return String(text)
    .split(/[\s,]+/)            // newline, space, comma
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}
let symbols = [];
if (symbolsFile && symbolsFile !== true) {
  const p = path.resolve(symbolsFile);
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, 'utf8');
    symbols = parseSymbols(t);
  }
}
if (!symbols.length && symbolsCSV && symbolsCSV !== true) {
  symbols = parseSymbols(symbolsCSV);
}
if (!symbols.length) {
  console.error('No symbols provided. Use --symbolsFile or --symbols.');
  process.exit(1);
}

/* ----------- feature config ---------- */
/**
 * Order must match featureVectorFromIndicators(...) in sciV1Engine.js
 *   [
 *     zS, z_dS, z_dHist,
 *     logRV, z_dLogRV,
 *     obvSlope10_scaled, z_obvSl,
 *     K, pctB, CLV,
 *     atrPct, z_ATRPct,
 *     BBW, z_dBBW,
 *     gapNorm, fill
 *   ]
 */
const FEATURE_INFO = [
  { key: 'zS',                lo: -3, hi: 3,    bins: 200 },
  { key: 'z_dS',              lo: -3, hi: 3,    bins: 200 },
  { key: 'z_dHist',           lo: -3, hi: 3,    bins: 200 },
  { key: 'logRV',             lo: -3, hi: 3,    bins: 200 },
  { key: 'z_dLogRV',          lo: -3, hi: 3,    bins: 200 },
  { key: 'obvSlope10_scaled', lo: -1, hi: 1,    bins: 200 },
  { key: 'z_obvSl',           lo: -3, hi: 3,    bins: 200 },
  { key: 'K',                 lo:  0, hi: 1,    bins: 200 },
  { key: 'pctB',              lo:  0, hi: 1,    bins: 200 },
  { key: 'CLV',               lo: -1, hi: 1,    bins: 200 },
  { key: 'atrPct',            lo:  0, hi: 0.2,  bins: 200 },
  { key: 'z_ATRPct',          lo: -3, hi: 3,    bins: 200 },
  { key: 'BBW',               lo:  0, hi: 1.5,  bins: 200 },
  { key: 'z_dBBW',            lo: -3, hi: 3,    bins: 200 },
  { key: 'gapNorm',           lo:  0, hi: 8,    bins: 200 },
  { key: 'fill',              lo: -1, hi: 1,    bins: 200 },
];

const FEATURE_KEYS = FEATURE_INFO.map(f => f.key);

/* ------ streaming stats helpers ------ */
function makeFeatAccumulators() {
  const acc = {};
  for (const f of FEATURE_INFO) {
    acc[f.key] = {
      n: 0,
      sumX: 0,
      sumX2: 0,
      sumXY_up: 0,
      sumXY_ret: 0,
      lo: f.lo, hi: f.hi, bins: f.bins,
      hN: new Array(f.bins).fill(0),
      hY: new Array(f.bins).fill(0),
      hRet: new Array(f.bins).fill(0),
    };
  }
  return acc;
}

function pushFeature(acc, key, x, yUp, yRet) {
  const a = acc[key];
  if (!Number.isFinite(x)) return;
  a.n++; a.sumX += x; a.sumX2 += x * x;
  a.sumXY_up += x * yUp;
  a.sumXY_ret += x * yRet;

  const { lo, hi, bins } = a;
  const t = Math.max(lo, Math.min(hi, x));
  const idx = Math.min(bins - 1, Math.max(0, Math.floor(((t - lo) / (hi - lo)) * bins)));
  a.hN[idx] += 1;
  a.hY[idx] += yUp;
  a.hRet[idx] += yRet;
}

function finalizeFeature(acc, key, base) {
  const a = acc[key];
  const n = a.n || 1;
  const meanX = a.sumX / n;
  const varX = Math.max(1e-12, (a.sumX2 / n) - meanX * meanX);
  const stdX = Math.sqrt(varX);

  const meanUp = base.upRate;
  const varUp = Math.max(1e-12, meanUp * (1 - meanUp));
  const covXUp = (a.sumXY_up / n) - meanX * meanUp;
  const corrUp = covXUp / Math.sqrt(varX * varUp);

  const meanRet = base.meanRet;
  const varRet = Math.max(1e-12, base.varRet);
  const covXRet = (a.sumXY_ret / n) - meanX * meanRet;
  const corrRet = covXRet / Math.sqrt(varX * varRet);

  // deciles via collapsing 200 bins
  const perDecile = [];
  let cum = 0, target = n / 10, nextCut = target, di = 0, iStart = 0;
  for (let i = 0; i < a.bins && di < 10; i++) {
    cum += a.hN[i];
    if (cum >= nextCut || i === a.bins - 1) {
      let nD = 0, yD = 0, rD = 0;
      for (let j = iStart; j <= i; j++) { nD += a.hN[j]; yD += a.hY[j]; rD += a.hRet[j]; }
      perDecile.push({ n: nD, upRate: nD ? yD / nD : null, meanRet: nD ? rD / nD : null });
      di++; iStart = i + 1; nextCut = target * (di + 1);
    }
  }

  return {
    key, n, mean: meanX, std: stdX,
    corrUp: Number.isFinite(corrUp) ? corrUp : 0,
    corrRet: Number.isFinite(corrRet) ? corrRet : 0,
    deciles: perDecile
  };
}

/* -------------- yahoo fetch -------------- */
async function fetchDaily(symbol, period1, period2) {
  const rows = await yahooFinance.historical(symbol, { period1, period2, interval: '1d' });
  return (rows || [])
    .map(r => ({ date: new Date(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
    .filter(r => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite))
    .sort((a, b) => a.date - b.date);
}

/* -------------- main -------------- */
(async () => {
  const start = new Date(fromStr + 'T00:00:00');
  const end   = new Date(toStr   + 'T00:00:00');
  const pre   = new Date(start); pre.setDate(pre.getDate() - 270); // warmup

  const base = { n: 0, upCount: 0, sumRet: 0, sumRet2: 0 };
  const acc = makeFeatAccumulators();
  const perSymbol = [];

  for (const sym of symbols) {
    try {
      const rows = await fetchDaily(sym, pre, end);
      if (rows.length < 80) continue;

      let nUsed = 0, upUsed = 0;
      for (let i = 40; i < rows.length - 1; i++) {
        const d = rows[i].date;
        if (d < start || d >= end) continue;

        const slice = rows.slice(0, i + 1);
        let f;
        try { f = computeIndicators(slice, {}); } catch { continue; }
        if (!(f.priceOk && f.liqOkUSD)) continue;

        const x = featureVectorFromIndicators(f); // ordered as FEATURE_KEYS
        const ret = Math.log(rows[i + 1].close / rows[i].close);
        const up  = rows[i + 1].close > rows[i].close ? 1 : 0;

        base.n++; base.upCount += up; base.sumRet += ret; base.sumRet2 += ret * ret;

        for (let j = 0; j < FEATURE_KEYS.length; j++) {
          pushFeature(acc, FEATURE_KEYS[j], x[j], up, ret);
        }

        nUsed++; upUsed += up;
      }
      if (nUsed) perSymbol.push({ symbol: sym, n: nUsed, upRate: upUsed / nUsed });
    } catch { /* continue */ }
  }

  if (!base.n) {
    console.error('No training samples found. Check dates/symbols.');
    process.exit(2);
  }

  const upRate = base.upCount / base.n;
  const meanRet = base.sumRet / base.n;
  const varRet = Math.max(1e-12, (base.sumRet2 / base.n) - meanRet * meanRet);

  const features = FEATURE_KEYS.map(k => finalizeFeature(acc, k, { upRate, meanRet, varRet }));

  const out = {
    meta: {
      createdAt: new Date().toISOString(),
      from: fromStr, to: toStr,
      symbols: symbols.length,
      totalObs: base.n,
      baseUpRate: upRate,
      meanNextDayLogRet: meanRet,
    },
    feature_config: FEATURE_INFO,
    features,
    perSymbol
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote summary → ${outPath}`);
})();

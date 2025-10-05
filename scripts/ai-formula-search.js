#!/usr/bin/env node
/**
 * ai-formula-search.js
 * LLM-guided search for a short-term formula.
 * - Builds a multi-symbol dataset of daily features + next-day label
 * - LLM proposes logistic weights; we evaluate; loop and keep best
 *
 * Usage:
 *   node scripts/ai-formula-search.js --symbolsFile data/sp500.txt \
 *     --from 2020-01-01 --to 2025-09-01 --iters 20 --valFrac 0.2 \
 *     --out model/ai_formula.json
 *
 * You can also pass --symbols AAPL,MSFT,NVDA instead of --symbolsFile.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const yahooFinance = require('yahoo-finance2').default;
if (yahooFinance.suppressNotices) yahooFinance.suppressNotices(['ripHistorical']);
const OpenAI = require('openai');

const args = minimist(process.argv.slice(2), {
  string: ['symbols', 'symbolsFile', 'from', 'to', 'out', 'model'],
  number: ['iters', 'valFrac'],
  default: { iters: 16, valFrac: 0.25, model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }
});

function parseSymbolsArg(val, file) {
  if (file) {
    const txt = fs.readFileSync(file, 'utf8');
    return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  if (val == null || val === true) return ['MSFT'];
  return String(val).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

const symbols = parseSymbolsArg(args.symbols, args.symbolsFile);
const fromStr = (args.from || '2020-01-01').slice(0, 10);
const toStr   = (args.to   || new Date().toISOString().slice(0,10)).slice(0, 10);
const outPath = args.out || 'model/ai_formula.json';
const iters   = Number(args.iters);
const valFrac = Math.min(0.9, Math.max(0.05, Number(args.valFrac || 0.25)));
const modelName = args.model;

// ---------- math utils ----------
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = arr => arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0;
const stdev = arr => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s,x)=>s+(x-m)**2,0)/arr.length) || 0;
};
const sigmoid = z => 1 / (1 + Math.exp(-z));


// ---------- indicators (aligned with your backtest) ----------
function EMA(vals, period) {
  const k = 2/(period+1);
  let e = vals[0];
  const out = [e];
  for (let i=1;i<vals.length;i++){ e = vals[i]*k + e*(1-k); out.push(e); }
  return out;
}
function RSI14(closes, p=14){
  if (closes.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){ const d=closes[i]-closes[i-1]; if (d>=0) g+=d; else l-=d; }
  g/=p; l/=p;
  let rs = l===0 ? 100 : g/l;
  let r = 100 - (100/(1+rs));
  for (let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    const G=d>0?d:0, L=d<0?-d:0;
    g=(g*(p-1)+G)/p; l=(l*(p-1)+L)/p;
    rs = l===0 ? 100 : g/l;
    r = 100 - (100/(1+rs));
  }
  return r;
}
function MACD(closes, fast=12, slow=26, sigP=9){
  if (closes.length < slow+sigP+5) return { macd:null, signal:null, hist:null };
  const ef = EMA(closes, fast);
  const es = EMA(closes, slow);
  const line = closes.map((_,i)=> ef[i]-es[i]);
  const sig  = EMA(line.slice(-sigP-50), sigP).pop();
  const val  = line[line.length-1];
  return { macd: val, signal: sig, hist: val - sig };
}
function BBands(closes, p=20){
  if (closes.length < p) return {pctB:null, sma:null, std:null};
  const arr = closes.slice(-p);
  const sma = mean(arr);
  const sd  = stdev(arr);
  const upper = sma + 2*sd, lower = sma - 2*sd;
  const last = closes[closes.length-1];
  const pctB = (upper===lower) ? 0.5 : (last - lower)/(upper - lower);
  return { pctB, sma, std: sd };
}
function ATR14(rows, p=14){
  if (rows.length < p+1) return null;
  const trs = [];
  for (let i=1;i<rows.length;i++){
    const h=rows[i].high, l=rows[i].low, pc=rows[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return EMA(trs, p).pop();
}
function OBV(rows){
  let v=0;
  for (let i=1;i<rows.length;i++){
    const dir = Math.sign(rows[i].close - rows[i-1].close);
    v += dir * (rows[i].volume||0);
  }
  return v;
}
function zScore(series){
  if (!series || series.length < 2) return 0;
  const m = mean(series), sd = stdev(series) || 1e-6;
  return (series[series.length-1] - m)/sd;
}

async function fetchDaily(symbol, start, end) {
  const rows = await yahooFinance.historical(symbol, {
    period1: start, period2: end, interval: '1d'
  });
  return (rows||[])
    .map(r => ({date:new Date(r.date), open:r.open, high:r.high, low:r.low, close:r.close, volume:r.volume}))
    .filter(r => [r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite))
    .sort((a,b)=>a.date-b.date);
}

// features used in both training + backtest
function computeFeatureVector(rows, i){
  const slice = rows.slice(0, i+1);
  const closes = slice.map(r=>r.close);
  const vols   = slice.map(r=>r.volume);
  const last   = slice.at(-1);

  const mom5     = (closes.at(-1)/closes.at(-6))-1;
  const rangePct = (last.high - last.low)/last.close;
  const gapPct   = (last.open/closes.at(-2))-1;

  const RSI = RSI14(closes, 14);
  const { hist: MHist } = MACD(closes);
  const { pctB } = BBands(closes, 20);
  const ATR = ATR14(slice, 14);
  const atrPct = ATR ? ATR/last.close : 0.01;

  const volZ = zScore(vols.slice(-60));
  const obvSeries = [];
  for (let k=Math.max(1, slice.length-60); k<slice.length; k++){
    obvSeries.push(OBV(slice.slice(0, k+1)));
  }
  const obvZ = zScore(obvSeries);

  // normalized features
  const rsiN  = (RSI!=null) ? clamp((RSI-50)/10, -3, 3) : 0;
  const macdN = (MHist!=null && ATR) ? clamp(MHist/ATR, -3, 3) : 0;
  const mom5N = clamp(mom5/0.05, -3, 3);
  const gapN  = clamp(gapPct/0.01, -3, 3);
  const rngN  = clamp(rangePct/0.03, 0, 3);
  const bbN   = (pctB!=null) ? clamp((pctB-0.5)*2, -2, 2) : 0;
  const volN  = clamp(volZ, -3, 3);
  const obvN  = clamp(obvZ, -3, 3);

  return { rsiN, macdN, mom5N, gapN, bbN, volN, obvN, rngN, bias: 1.0 };
}

const FEAT_NAMES = ['rsiN','macdN','mom5N','gapN','bbN','volN','obvN','rngN','bias'];

// ---------- dataset ----------
async function buildDataset() {
  const start = new Date(fromStr+'T00:00:00');
  const end   = new Date(toStr  +'T00:00:00');
  const pre   = new Date(start); pre.setDate(pre.getDate()-220);

  const X = [], y = [];
  for (const sym of symbols) {
    const rows = await fetchDaily(sym, pre, end);
    if (rows.length < 80) continue;
    for (let i=40; i<rows.length-1; i++){
      const d = rows[i].date;
      if (d < start || d >= end) continue;
      const fv = computeFeatureVector(rows, i);
      const yi = rows[i+1].close > rows[i].close ? 1 : 0;
      X.push(FEAT_NAMES.map(k => fv[k]));
      y.push(yi);
    }
  }
  return { X, y };
}

function trainValSplit(X, y, valFrac){
  const n = X.length;
  const nVal = Math.max(1, Math.floor(n * valFrac));
  return {
    Xtr: X.slice(0, n-nVal), ytr: y.slice(0, n-nVal),
    Xva: X.slice(n-nVal),    yva: y.slice(n-nVal)
  };
}

// metrics
function brier(preds, labels){ let s=0; for (let i=0;i<preds.length;i++) s+=(preds[i]-labels[i])**2; return s/preds.length; }
function acc(preds, labels){ let hits=0; for (let i=0;i<preds.length;i++) hits += (preds[i]>=0.5?1:0) === labels[i] ? 1 : 0; return hits/preds.length; }
function auc(preds, labels){
  const pairs = preds.map((p,i)=>({p,y:labels[i]})).sort((a,b)=>a.p-b.p);
  let pos=0,neg=0,rankSum=0;
  for (let i=0;i<pairs.length;i++){ if (pairs[i].y===1){pos++; rankSum += i+1;} else neg++; }
  if (!pos || !neg) return 0.5;
  return (rankSum - pos*(pos+1)/2) / (pos*neg);
}

// evaluate a formula object
function evalFormula(formula, X, y){
  const w = FEAT_NAMES.map(name => (formula.weights?.[name] ?? 0));
  const preds = X.map(row => sigmoid(row.reduce((s, v, j)=> s + v*w[j], 0)));
  return {
    brier: brier(preds, y),
    acc:   acc(preds, y),
    auc:   auc(preds, y),
    preds
  };
}

// ---------- LLM loop ----------
function defaultFormula() {
  // sane starting point roughly matching your hard-coded weights
  return {
    schema: "shortterm-logistic-v1",
    weights: {
      rsiN: 0.8, macdN: 0.6, mom5N: 0.5, gapN: 0.3, bbN: 0.2, volN: 0.15, obvN: 0.10, rngN: -0.2, bias: 0.15
    },
    notes: "seed"
  };
}

function summarizeDataset(X, y){
  const n = X.length;
  const baseUp = mean(y);
  const feats = {};
  FEAT_NAMES.forEach((name, j) => {
    const col = X.map(r => r[j]);
    // simple correlation with y
    const mX = mean(col), sX = stdev(col) || 1e-9;
    const mY = baseUp, sY = stdev(y) || 1e-9;
    const cov = mean(col.map((v,i)=> (v-mX)*(y[i]-mY)));
    const corr = cov / (sX*sY);
    feats[name] = { mean: +mX.toFixed(4), stdev: +sX.toFixed(4), corrY: +corr.toFixed(4) };
  });
  return { n, baseUp: +baseUp.toFixed(4), feats };
}

async function askLLMForWeights(client, model, dataSummary, lastResults){
  const sys = `You are optimizing a one-day-ahead up/down logistic model for stocks.
Return ONLY a compact JSON object that matches this TypeScript type:

type Formula = {
  schema: "shortterm-logistic-v1",
  weights: { [k in "${FEAT_NAMES.join('" | "')}"]: number },
  notes?: string
}

Constraints:
- Keep weights within [-3, 3].
- Prefer small |weights| unless they improve Brier loss on validation.
- If range feature ("rngN") is too large, it should dampen the signal (negative).
- "bias" shifts overall base rate; adjust gently (|bias|<=0.6).
- Optimize primarily for lower Brier; ties broken by higher AUC, then Accuracy.
- Respond with VALID JSON ONLY — no prose.`;

  const usr = `
DATA SUMMARY (validation slice)
${JSON.stringify(dataSummary, null, 2)}

LAST EVAL
${lastResults ? JSON.stringify(lastResults, null, 2) : 'none'}

Please propose updated "weights" (and optional short "notes").`;

  // Use Chat Completions for compatibility
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr }
    ]
  });

  const txt = resp.choices?.[0]?.message?.content?.trim() || '{}';
  try {
    // some models wrap in ```json ... ```
    const cleaned = txt.replace(/```json|```/g, '');
    const j = JSON.parse(cleaned);
    return j;
  } catch {
    return defaultFormula();
  }
}

(async () => {
  console.log(`Building dataset for ${symbols.length} symbols from ${fromStr} to ${toStr} …`);
  const { X, y } = await buildDataset();
  if (X.length < 500) {
    console.error(`Not enough samples (${X.length}). Try adding more symbols or a wider date range.`);
    process.exit(1);
  }
  const { Xtr, ytr, Xva, yva } = trainValSplit(X, y, valFrac);
  console.log(`Train: ${Xtr.length}, Val: ${Xva.length}`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let best = { formula: defaultFormula(), metrics: evalFormula(defaultFormula(), Xva, yva) };
  let lastFeedback = null;

  const dataSummary = summarizeDataset(Xva, yva);
  console.log(`BaseUp(val)=${dataSummary.baseUp.toFixed(3)}; starting Brier=${best.metrics.brier.toFixed(4)} AUC=${best.metrics.auc.toFixed(4)} ACC=${(best.metrics.acc*100).toFixed(2)}%`);

  for (let t=0; t<iters; t++){
    const proposal = await askLLMForWeights(client, modelName, dataSummary, {
      bestMetrics: best.metrics,
      bestWeights: best.formula.weights,
      notes: lastFeedback || 'none'
    });

    // sanity + clamp
    const weights = Object.fromEntries(FEAT_NAMES.map(k => {
      let v = Number(proposal?.weights?.[k]);
      if (!Number.isFinite(v)) v = best.formula.weights[k] ?? 0;
      return [k, clamp(v, -3, 3)];
    }));
    const formula = { schema: 'shortterm-logistic-v1', weights, notes: proposal.notes || '' };
    const m = evalFormula(formula, Xva, yva);

    const scoreKey = (r) => (r.brier + 0.0001*(1-r.auc) + 0.00001*(1-r.acc)); // primary Brier, then AUC, then Acc
    const isBetter = scoreKey(m) < scoreKey(best.metrics);

    console.log(`Iter ${t+1}/${iters}  brier=${m.brier.toFixed(4)}  auc=${m.auc.toFixed(4)}  acc=${(m.acc*100).toFixed(2)}%  ${isBetter?'✅':'—'}`);

    if (isBetter) {
      best = { formula, metrics: m };
      lastFeedback = `Improved. Keep directionality. Focus on calibration around p=0.55-0.70; current best=${JSON.stringify(best.metrics)}`;
    } else {
      lastFeedback = `Worse than best. Penalize overconfident weights; shrink toward 0 except features with positive corrY. Current best=${JSON.stringify(best.metrics)}`;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ...best.formula, metrics: best.metrics, features: FEAT_NAMES }, null, 2));
  console.log(`Saved best formula → ${outPath}`);
  console.log(`Best on validation: brier=${best.metrics.brier.toFixed(4)} auc=${best.metrics.auc.toFixed(4)} acc=${(best.metrics.acc*100).toFixed(2)}%`);
})();

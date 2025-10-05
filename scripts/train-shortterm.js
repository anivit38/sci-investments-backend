#!/usr/bin/env node
/* train-shortterm.js
   Cross-sectional trainer: gather samples over many symbols and fit logistic regression.
*/

const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const yahooFinance = require('yahoo-finance2').default;
try { yahooFinance.suppressNotices && yahooFinance.suppressNotices(['ripHistorical']); } catch {}
const minimist = require('minimist');

const args = minimist(process.argv.slice(2), {
  string: ['symbols', 'symbolsFile', 'from', 'to', 'out'],
  default: { from: '2023-01-01', to: new Date().toISOString().slice(0,10), out: 'model/shortterm_logreg.json' }
});

function parseSymbols() {
  if (args.symbolsFile && fs.existsSync(args.symbolsFile)) {
    return fs.readFileSync(args.symbolsFile,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  }
  if (args.symbols) return String(args.symbols).split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
  return ['AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA']; // fallback
}

/* ==== features (mirror backtester) ==== */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function EMA(vals, period){ const k=2/(period+1); let e=vals[0]; const out=[e]; for(let i=1;i<vals.length;i++){ e=vals[i]*k+e*(1-k); out.push(e);} return out; }
function RSI14(closes,p=14){ if(closes.length<p+1)return null; let g=0,l=0; for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1]; if(d>=0)g+=d; else l-=d;} g/=p; l/=p; let rs=l===0?100:g/l; let r=100-(100/(1+rs)); for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1]; const G=d>0?d:0; const L=d<0?-d:0; g=(g*(p-1)+G)/p; l=(l*(p-1)+L)/p; rs=l===0?100:g/l; r=100-(100/(1+rs)); } return r; }
function ATR14(rows,p=14){ if(rows.length<p+1)return null; const trs=[]; for(let i=1;i<rows.length;i++){const h=rows[i].high,l=rows[i].low,pc=rows[i-1].close; trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));} return EMA(trs,p).at(-1); }
function MACD(closes,f=12,s=26,sigP=9){ if(closes.length<s+sigP+5)return{hist:null}; const ef=EMA(closes,f), es=EMA(closes,s); const line=closes.map((_,i)=>ef[i]-es[i]); const sig=EMA(line.slice(-sigP-50),sigP).pop(); const val=line.at(-1); return {hist: val - sig}; }
function BBands(closes,p=20){ if(closes.length<p)return{pctB:null}; const a=closes.slice(-p); const sma=a.reduce((s,x)=>s+x,0)/p; const std=Math.sqrt(a.reduce((s,x)=>s+(x-sma)**2,0)/p)||1e-12; const upper=sma+2*std, lower=sma-2*std; const last=closes.at(-1); return {pctB:(last-lower)/(upper-lower)}; }
function OBV(rows){ let v=0; for(let i=1;i<rows.length;i++){const dir=Math.sign(rows[i].close-rows[i-1].close); v+=dir*rows[i].volume;} return v; }
function zScore(series){ if(series.length<2)return 0; const m=series.reduce((s,x)=>s+x,0)/series.length; const sd=Math.sqrt(series.reduce((s,x)=>s+(x-m)**2,0)/series.length)||1e-6; return (series.at(-1)-m)/sd; }

function rowToFeatures(slice) {
  const closes = slice.map(r=>r.close);
  const vols   = slice.map(r=>r.volume);
  const last   = slice.at(-1);

  const mom5     = (closes.at(-1) / closes.at(-6)) - 1;
  const rangePct = (last.high - last.low) / last.close;
  const gapPct   = (last.open / closes.at(-2)) - 1;

  const RSI = RSI14(closes,14);
  const {hist:MHist} = MACD(closes);
  const {pctB} = BBands(closes,20);
  const ATR = ATR14(slice,14);
  const atrPct = ATR ? ATR / last.close : 0.01;

  const volZ = zScore(vols.slice(-60));
  const obvSeries = [];
  for (let k=Math.max(1, slice.length-60); k<slice.length; k++) obvSeries.push(OBV(slice.slice(0,k+1)));
  const obvZ = zScore(obvSeries);

  const rsiN  = (RSI!=null)?clamp((RSI-50)/10, -3, 3):0;
  const macdN = (MHist!=null&&ATR)?clamp(MHist/ATR, -3, 3):0;
  const mom5N = clamp(mom5/0.05, -3, 3);
  const gapN  = clamp(gapPct/0.01, -3, 3);
  const rngN  = clamp(rangePct/0.03, 0, 3);
  const bbN   = (pctB!=null)?clamp((pctB-0.5)*2, -2, 2):0;
  const volN  = clamp(volZ, -3, 3);
  const obvN  = clamp(obvZ, -3, 3);

  // feature vector (same order everywhere)
  return [rsiN, macdN, mom5N, gapN, rngN, bbN, volN, obvN];
}

async function fetchDaily(symbol, start, end) {
  const rows = await yahooFinance.historical(symbol, { period1: start, period2: end, interval: '1d' });
  return (rows||[])
    .map(r=>({date:new Date(r.date),open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume}))
    .filter(r=>[r.open,r.high,r.low,r.close,r.volume].every(Number.isFinite))
    .sort((a,b)=>a.date-b.date);
}

(async () => {
  const syms = parseSymbols();
  const start = new Date(args.from + 'T00:00:00');
  const end   = new Date(args.to   + 'T00:00:00');

  const X = []; const y = [];
  const featureNames = ['rsiN','macdN','mom5N','gapN','rngN','bbN','volN','obvN'];

  for (const sym of syms) {
    const pre = new Date(start); pre.setDate(pre.getDate() - 300);
    const rows = await fetchDaily(sym, pre, end);
    if (rows.length < 80) continue;

    for (let i = 50; i < rows.length-1; i++) {
      const d = rows[i].date;
      if (d < start || d >= end) continue;
      const slice = rows.slice(0, i+1);
      const f = rowToFeatures(slice);
      const label = rows[i+1].close > rows[i].close ? 1 : 0;
      X.push(f); y.push(label);
    }
  }

  if (X.length < 2000) console.log(`Warning: small dataset (N=${X.length})`);

  // standardize X
  const d = X[0].length;
  const means = Array(d).fill(0).map((_,j)=> X.reduce((s,row)=>s+row[j],0)/X.length);
  const stds  = Array(d).fill(0).map((_,j)=> {
    const m = means[j];
    const v = X.reduce((s,row)=> s + (row[j]-m)**2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  const Xn = X.map(row => row.map((v,j)=> (v-means[j])/stds[j]));

  // train/val split
  const N = Xn.length;
  const idx = [...Array(N).keys()];
  idx.sort(()=>Math.random()-0.5);
  const split = Math.floor(N*0.8);
  const trainIdx = idx.slice(0,split), valIdx = idx.slice(split);

  function take(mat, inds){ return inds.map(i=>mat[i]); }
  const Xtr = take(Xn, trainIdx), ytr = take(y, trainIdx);
  const Xva = take(Xn, valIdx),   yva = take(y, valIdx);

  // logistic regression with TFJS (1-layer)
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 1, inputShape:[d], activation: 'sigmoid', useBias: true }));
  model.compile({ optimizer: tf.train.adam(0.03), loss: 'binaryCrossentropy', metrics: ['accuracy'] });

  const xt = tf.tensor2d(Xtr), yt = tf.tensor2d(ytr,[ytr.length,1]);
  const xv = tf.tensor2d(Xva), yv = tf.tensor2d(yva,[yva.length,1]);

  await model.fit(xt, yt, { epochs: 80, batchSize: 256, validationData: [xv,yv], verbose: 0 });

  const evalRes = model.evaluate(xv, yv, { verbose: 0 });
  const [valLossT, valAccT] = await Promise.all(evalRes.map(t=>t.data()));
  console.log(`Validation: loss=${valLossT[0].toFixed(4)} acc=${(valAccT[0]*100).toFixed(2)}% (N=${yva.length})`);

  // extract weights
  const [kernel, bias] = model.getWeights();
  const wArr = (await kernel.array())[0] ? await kernel.array() : await kernel.data();
  const bArr = await bias.data();
  const W = Array.isArray(wArr[0]) ? wArr.map(r=>r[0]) : Array.from(wArr);
  const b = bArr[0];

  // save JSON model
  const out = {
    featureNames,
    means, stds,
    W, b,
    meta: { from: args.from, to: args.to, symbols: syms, N }
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(`Saved model → ${args.out}`);
})();

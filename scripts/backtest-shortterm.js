#!/usr/bin/env node
/* backtest-shortterm.js
   Walk-forward backtest of the *same* short-term model used in server.js,
   with param changes requested + optional AI formula support.
*/

const fs = require('fs');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;
try { yahooFinance.suppressNotices && yahooFinance.suppressNotices(['ripHistorical']); } catch {}
const minimist = require('minimist');

// >>> EXPLAIN: bring in attribution helpers
const { buildWrongRow, writeWrongCsv, summarizeBlame, summarizeBlamePlus } = require('./explain-utils');


// indicator pack for AI model features (safe; used only when --aiModel is passed)
let computeIndicators = null;
try {
  ({ computeIndicators } = require('../services/sciV1Engine.js'));
} catch { /* optional */ }

/* ---------- args ---------- */
const args = minimist(process.argv.slice(2), {
  string: ['symbols', 'from', 'to', 'out', 'errors', 'threshold', 'aiModel'],
  boolean: ['longShort', 'sweep', 'analyze', 'aggregate'],
  default: {
    longShort: true,
    sweep: false,
    analyze: false,
    aggregate: false,
    threshold: 0.5,
    minConf: 0.45,
    atrMax: 0.045,
    temp: 1.0
  }
});

function parseSymbols(val) {
  if (!val) return ['MSFT'];
  return String(val).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

const symbols   = parseSymbols(args.symbols);
const fromStr   = (args.from || '2024-01-01').slice(0,10);
const toStr     = (args.to   || new Date().toISOString().slice(0,10)).slice(0,10);
const outPath   = args.out || null;
const errPath   = args.errors || null;
const threshold = Number(args.threshold || 0.5);
const minConf   = Number(args.minConf);
const longShort = !!args.longShort;
const doSweep   = !!args.sweep;
const doAnalyze = !!args.analyze;
const doAgg     = !!args.aggregate;
const atrMax    = Number(args.atrMax);
const tempArg   = Number(args.temp || 1.0);
const temp      = Math.max(1.0, tempArg); // enforce min temp = 1.0

const aiModelPath = args.aiModel ? String(args.aiModel) : null;

/* ---------- helpers / indicators (classic model) ---------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function EMA(vals, period) {
  const k = 2 / (period + 1);
  let e = vals[0];
  const out = [e];
  for (let i = 1; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function RSI14(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= p; loss /= p;
  let rs = loss === 0 ? 100 : gain / loss;
  let rsi = 100 - (100 / (1 + rs));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (p - 1) + g) / p;
    loss = (loss * (p - 1) + l) / p;
    rs = loss === 0 ? 100 : gain / loss;
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
}
function ATR14(rows, p = 14) {
  if (rows.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const e = EMA(trs, p);
  return e[e.length - 1];
}
function MACD(closes, fast = 12, slow = 26, sigP = 9) {
  if (closes.length < slow + sigP + 5) return { macd: null, signal: null, hist: null };
  const ef = EMA(closes, fast);
  const es = EMA(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sig = EMA(line.slice(-sigP - 50), sigP).pop();
  const val = line[line.length - 1];
  return { macd: val, signal: sig, hist: val - sig };
}
function BBands(closes, p = 20) {
  if (closes.length < p) return { upper: null, lower: null, pctB: null, sma: null, std: null };
  const arr = closes.slice(-p);
  const sma = arr.reduce((s, x) => s + x, 0) / p;
  const std = Math.sqrt(arr.reduce((s, x) => s + (x - sma) ** 2, 0) / p);
  const upper = sma + 2 * std, lower = sma - 2 * std;
  const last = closes[closes.length - 1];
  const pctB = (last - lower) / (upper - lower);
  return { upper, lower, pctB, sma, std };
}
function OBV(rows) {
  let v = 0;
  for (let i = 1; i < rows.length; i++) {
    const dir = Math.sign(rows[i].close - rows[i - 1].close);
    v += dir * rows[i].volume;
  }
  return v;
}
function zScore(series) {
  if (series.length < 2) return 0;
  const m = series.reduce((s, x) => s + x, 0) / series.length;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - m) ** 2, 0) / series.length) || 1e-6;
  return (series[series.length - 1] - m) / sd;
}

async function fetchDaily(symbol, start, end) {
  const rows = await yahooFinance.historical(symbol, { period1: start, period2: end, interval: '1d' });
  return (rows || [])
    .map(r => ({ date: new Date(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
    .filter(r => [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite))
    .sort((a, b) => a.date - b.date);
}

/* ---------- classic model at index ---------- */
function classicPredictAtIndex(rows, i) {
  if (i < 40) return null;
  const slice = rows.slice(0, i + 1);
  const closes = slice.map(r => r.close);
  const vols   = slice.map(r => r.volume);
  const last   = slice[slice.length - 1];

  const mom5     = (closes.at(-1) / closes.at(-6)) - 1;
  const rangePct = (last.high - last.low) / last.close;
  const gapPct   = (last.open / closes.at(-2)) - 1;

  const RSIv = RSI14(closes, 14);
  const { hist: MHist } = MACD(closes);
  const { pctB } = BBands(closes, 20);
  const ATR = ATR14(slice, 14);
  const atrPct = ATR ? ATR / last.close : 0.01;

  // >>> EXPLAIN: compute extra raw features for attribution
  const prevATR = i>=15 ? ATR14(rows.slice(0, i), 14) : null;
  const deltaATRpct = (prevATR && ATR) ? (ATR/last.close - prevATR/rows[i-1].close) : 0;
  // Stoch %K(14)
  let stochK = null;
  if (slice.length >= 15) {
    const look = slice.slice(-14-1); // 14 periods + current
    const hh = Math.max(...look.map(r=>r.high));
    const ll = Math.min(...look.map(r=>r.low));
    stochK = (hh>ll) ? 100*(last.close - ll)/(hh-ll) : 50;
  }
  const obvVal = OBV(slice);

  const volZ = zScore(vols.slice(-60));

  const macdRatio = (MHist != null && ATR) ? (MHist / ATR) : 0;
  const mom5N = clamp(mom5 / 0.05, -3, 3);
  const gapNorm = gapPct / 0.01; // 1.0 ~ +1% gap

  const rsiN  = (RSIv != null) ? clamp((RSIv - 50) / 10, -3, 3) : 0;
  const macdN = clamp(macdRatio, -3, 3);
  const rngN  = clamp(rangePct / 0.03, 0, 3);
  const bbN   = (pctB != null) ? clamp((pctB - 0.5) * 2, -2, 2) : 0;
  const volN  = clamp(volZ, -3, 3);

  const z =
      0.15
    + 0.80 * rsiN
    + 0.60 * macdN
    + 0.50 * mom5N
    + 0.30 * (gapNorm/1.0) // keep same weight semantics
    + 0.20 * bbN
    + 0.15 * volN
    - 0.20 * rngN;

  const pUp = 1 / (1 + Math.exp(-(z / temp)));

  const magnitude = clamp(
    (atrPct || 0.01) * (1
      + 0.25 * Math.abs(volN)
      + 0.35 * Math.abs(macdN)
      + 0.20 * Math.abs(gapNorm)
      + 0.25 * Math.abs(mom5N)
    ),
    0.002, 0.08
  );

  // >>> EXPLAIN: return features for the wrong-call reporter
  const features = {
    RSI: RSIv ?? '',
    MACD: macdRatio,
    stochK: stochK ?? '',
    gapNorm,
    pctB: pctB ?? '',
    atrPct,
    deltaATRpct,
    OBV: obvVal,
    volZ
  };

  return { pUp, magnitude, atrPct, features, modelWeights: {} };
}

/* ---------- AI model support ---------- */
function makeAiPredictor(modelJson) {
  if (!computeIndicators) {
    throw new Error('AI model requested but services/sciV1Engine.js not available.');
  }
  const keys = modelJson.feature_order || [];
  const weights = modelJson.sigmoid?.weights || {};
  const intercept = Number(modelJson.sigmoid?.intercept ?? 0);

  const ruleMinConf = Number(modelJson.rules?.minConf ?? minConf);
  const ruleAtrMax  = Number(modelJson.rules?.atrMax  ?? atrMax);
  const ruleMinTemp = Number(modelJson.rules?.minTemp ?? temp);

  const effMinConf = Number.isFinite(minConf) ? minConf : ruleMinConf;
  const effAtrMax  = Number.isFinite(atrMax)  ? atrMax  : ruleAtrMax;
  const effTemp    = Math.max(1.0, Number.isFinite(temp) ? temp : ruleMinTemp);

  return {
    weights, // >>> EXPLAIN: expose weights for attribution
    predict(rows, i) {
      if (i < 40) return null;
      const slice = rows.slice(0, i + 1);

      let f;
      try { f = computeIndicators(slice, {}); } catch { return null; }
      if (!(f.priceOk && f.liqOkUSD)) return null;

      const feat = {
        zS: f.zS,
        z_dS: f.z_dS,
        z_dHist: f.z_dHist,
        logRV: f.logRV,
        z_dLogRV: f.z_dLogRV,
        obvSlope10_scaled: Math.tanh((f.obvSlope10 || 0) / 1e9),
        z_obvSl: f.z_obvSl,
        K: f.K,
        pctB: f.pctB,
        CLV: f.CLV,
        atrPct: f.atrPct,
        z_ATRPct: f.z_ATRPct,
        BBW: f.BBW,
        z_dBBW: f.z_dBBW,
        gapNorm: f.gapNorm,
        fill: f.fill
      };

      let z = intercept;
      for (const k of keys) { z += (weights[k] || 0) * (feat[k] ?? 0); }

      const pUp = 1 / (1 + Math.exp(-(z / effTemp)));
      const magnitude = clamp(Math.max(feat.atrPct || 0.01, 0.002), 0.002, 0.08);

      // >>> EXPLAIN: return features + weights for wrong-call report
      return { pUp, magnitude, atrPct: feat.atrPct, features: feat, modelWeights: weights, _rules: { effMinConf, effAtrMax, effTemp } };
    }
  };
}

let AI = null;
if (aiModelPath) {
  if (!fs.existsSync(aiModelPath)) {
    console.error(`aiModel not found: ${aiModelPath}`);
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync(aiModelPath, 'utf8'));
  AI = makeAiPredictor(j);
  console.log(`Using AI model from ${aiModelPath}`);
}

/* ---------- metrics ---------- */
function brierScore(preds, labels){ let s=0; for(let i=0;i<preds.length;i++) s+=(preds[i]-labels[i])**2; return preds.length?s/preds.length:0; }
function rocAuc(preds, labels) {
  const pairs = preds.map((p,i)=>({p,y:labels[i]})).sort((a,b)=>a.p-b.p);
  let pos=0,neg=0,rankSum=0;
  for (let i=0;i<pairs.length;i++){ if(pairs[i].y===1){pos++; rankSum+=i+1;} else {neg++;} }
  if(!pos||!neg) return 0.5;
  return (rankSum - pos*(pos+1)/2) / (pos*neg);
}

/* ---------- main ---------- */
(async () => {
  const aggPreds = [];
  const aggWrongSimple = [];           // keep your simple rows (for compatibility)
  const aggWrongDetailed = [];         // >>> EXPLAIN: detailed wrong-call rows

  for (const sym of symbols) {
    const start = new Date(fromStr+'T00:00:00');
    const end   = new Date(toStr  +'T00:00:00');
    const pre = new Date(start); pre.setDate(pre.getDate() - 270);

    const rows = await fetchDaily(sym, pre, end);
    if (rows.length < 60) { console.log(`No data for ${sym}`); continue; }

    const outRows = [], wrongRowsSimple = [];
    const wrongRowsDetailed = [];      // >>> EXPLAIN
    const preds = [], labels = [];
    let tp=0,fp=0,tn=0,fn=0, acted=0;

    for (let i = 40; i < rows.length - 1; i++) {
      const d = rows[i].date;
      if (d < start || d >= end) continue;

      const yNext = rows[i+1].close > rows[i].close ? 1 : 0;
      const pred = AI ? AI.predict(rows, i) : classicPredictAtIndex(rows, i);
      if (!pred) continue;

      const { pUp, magnitude, atrPct } = pred;
      const features = pred.features || {};                 // >>> EXPLAIN
      const modelWeights = pred.modelWeights || (AI?.weights || {}); // >>> EXPLAIN

      // Rule gates
      const effMinConf = AI && pred._rules ? pred._rules.effMinConf : minConf;
      const effAtrMax  = AI && pred._rules ? pred._rules.effAtrMax  : atrMax;

      if (atrPct != null && effAtrMax != null && atrPct > effAtrMax) {
        preds.push(pUp); labels.push(yNext);
        outRows.push({
          symbol: sym, date: d.toISOString().slice(0,10),
          pUp: +pUp.toFixed(4), magnitudePct: +(magnitude*100).toFixed(3),
          predictedDirection: 'Neutral',
          actualDirection: yNext ? 'Up' : 'Down',
          hit: 0,
          retNextDayPct: +(((rows[i+1].close/rows[i].close)-1)*100).toFixed(3),
          atrPct: atrPct != null ? +(atrPct*100).toFixed(2) : ''
        });
        continue;
      }

      // decision policy
      let decide = null;
      const cut = Math.max(threshold, effMinConf);
      if (!longShort) {
        if (pUp >= cut) decide = 'Up';
      } else {
        if (pUp >= cut) decide = 'Up';
        else if (pUp <= (1 - cut)) decide = 'Down';
      }

      // >>> EXPLAIN: numeric mapping + ret1d for explanation rows
      const predDir = decide==='Up' ? 1 : (decide==='Down' ? -1 : 0);
      const actualDir = yNext ? 1 : -1;
      const ret1d = (rows[i+1].close/rows[i].close)-1;

      if (decide) {
        acted++;
        const yhat = decide === 'Up' ? 1 : 0;
        if (yhat===1 && yNext===1) tp++;
        if (yhat===1 && yNext===0) fp++;
        if (yhat===0 && yNext===0) tn++;
        if (yhat===0 && yNext===1) fn++;

        if ((yhat===1 && yNext===0) || (yhat===0 && yNext===1)) {
          // keep your simple row
          wrongRowsSimple.push({
            symbol: sym, date: d.toISOString().slice(0,10),
            pUp: +pUp.toFixed(4), decide,
            retNextDayPct: +((ret1d)*100).toFixed(3),
            atrPct: atrPct != null ? +(atrPct*100).toFixed(2) : ''
          });
          // >>> EXPLAIN: add detailed row with features + why
          const gates = {
            atr_pass: !(atrPct != null && effAtrMax != null && atrPct > effAtrMax),
            minConf_pass: (Math.abs(pUp - 0.5) * 2) >= (AI ? (pred._rules?.effMinConf ?? minConf) : minConf)
          };
          const detail = buildWrongRow({
            symbol: sym,
            date: d.toISOString().slice(0,10),
            pUp,
            pred: predDir,
            actual: actualDir,
            ret1d,
            features,
            modelWeights,
            gates,
            params: { atrMax, minConf }
          });
          wrongRowsDetailed.push(detail);
        }
      }

      preds.push(pUp); labels.push(yNext);
      outRows.push({
        symbol: sym, date: d.toISOString().slice(0,10),
        pUp: +pUp.toFixed(4), magnitudePct: +(magnitude*100).toFixed(3),
        predictedDirection: decide || 'Neutral',
        actualDirection: yNext ? 'Up' : 'Down',
        hit: ((pUp>=0.5?1:0)===yNext)?1:0,
        retNextDayPct: +((ret1d)*100).toFixed(3),
        atrPct: atrPct != null ? +(atrPct*100).toFixed(2) : ''
      });
    }

    // write CSVs (per symbol OR aggregate later)
    if (!doAgg) {
      if (outPath) {
        const header = 'symbol,date,pUp,magnitudePct,predictedDirection,actualDirection,hit,retNextDayPct,atrPct';
        const csv = [header].concat(outRows.map(r =>
          [r.symbol,r.date,r.pUp,r.magnitudePct,r.predictedDirection,r.actualDirection,r.hit,r.retNextDayPct,r.atrPct].join(',')
        )).join('\n');
        const pth = outPath.includes('.csv')
          ? outPath.replace(/\.csv$/i, `.${sym}.csv`)
          : outPath;
        fs.mkdirSync(path.dirname(pth), { recursive: true });
        fs.writeFileSync(pth, csv);
      }
      if (errPath) {
        // keep simple wrongs for continuity
        const header = 'symbol,date,pUp,decide,retNextDayPct,atrPct';
        const csv = [header].concat(wrongRowsSimple.map(r =>
          [r.symbol,r.date,r.pUp,r.decide,r.retNextDayPct,r.atrPct].join(',')
        )).join('\n');
        const pthSimple = errPath.includes('.csv')
          ? errPath.replace(/\.csv$/i, `.${sym}.csv`)
          : errPath;
        fs.mkdirSync(path.dirname(pthSimple), { recursive: true });
        fs.writeFileSync(pthSimple, csv);

        // >>> EXPLAIN: write detailed wrong diagnostics as <name>.detailed.<sym>.csv
        const pthDetailed = errPath.includes('.csv')
          ? errPath.replace(/\.csv$/i, `.detailed.${sym}.csv`)
          : `${errPath}.detailed.${sym}.csv`;
        if (wrongRowsDetailed.length) {
          writeWrongCsv(pthDetailed, wrongRowsDetailed);
          summarizeBlame(wrongRowsDetailed);
          const blamePath = pthDetailed.replace(/\.csv$/i, '.blame.csv');
          summarizeBlamePlus(wrongRowsDetailed, blamePath);
          console.log(`Saved blame summary → ${blamePath}`);
          console.log(`Saved detailed wrong-trade diagnostics → ${pthDetailed} (n=${wrongRowsDetailed.length})`);
        }
      }
    } else {
      aggPreds.push(...outRows);
      aggWrongSimple.push(...wrongRowsSimple);
      aggWrongDetailed.push(...wrongRowsDetailed);
    }

    // metrics (per symbol)
    const days = outRows.length;
    const acc  = days ? outRows.reduce((s,r)=>s+(r.hit?1:0),0)/days : 0;
    const precisionUp=(tp+fp)?tp/(tp+fp):0;
    const recallUp   =(tp+fn)?tp/(tp+fn):0;
    const f1Up       =(precisionUp+recallUp)?(2*precisionUp*recallUp)/(precisionUp+recallUp):0;
    const brier      = brierScore(preds, labels);
    const auc        = rocAuc(preds, labels);

    console.log(`Backtesting ${sym} from ${fromStr} to ${toStr} (${AI?'AI model':'classic'}; thr ${threshold}, minConf ${minConf}, ${longShort?'long/short':'long-only'}, atrMax ${atrMax}, temp ${temp})\n`);
    console.log('Summary');
    console.log('-------');
    console.log(`Days                : ${days}`);
    console.log(`Accuracy (naive 0.5): ${(acc*100).toFixed(2)}%`);
    console.log(`Decisions taken     : ${acted} (${days?((acted/days)*100).toFixed(1):'0'}% of days)`);
    console.log(`Precision (Up)      : ${(precisionUp*100).toFixed(2)}%`);
    console.log(`Recall   (Up)       : ${(recallUp*100).toFixed(2)}%`);
    console.log(`F1       (Up)       : ${(f1Up*100).toFixed(2)}%`);
    console.log(`Brier Score         : ${brier.toFixed(4)}`);
    console.log(`ROC AUC             : ${auc.toFixed(4)}\n`);

    if (doAnalyze) {
      // place deeper diagnostics here if desired
    }

    if (doSweep) {
      const bands=[0.50,0.52,0.55,0.58,0.60,0.62,0.65];
      console.log('Threshold sweep (long-only, confidence bands)');
      for (const c of bands){
        let taken=0,hits=0;
        for (let i=0;i<preds.length;i++){
          const p=preds[i], y=labels[i];
          if (p>=c){ taken++; if (y===1) hits++; }
        }
        console.log(`minConf ${c.toFixed(2)} → ${taken?`win% ${(hits/taken*100).toFixed(2)}%  (n=${taken})`:'no trades'}`);
      }
      console.log();
    }
  }

  if (doAgg && aggPreds.length) {
    // aggregate CSVs
    if (outPath) {
      const header = 'symbol,date,pUp,magnitudePct,predictedDirection,actualDirection,hit,retNextDayPct,atrPct';
      const csv = [header].concat(aggPreds.map(r =>
        [r.symbol,r.date,r.pUp,r.magnitudePct,r.predictedDirection,r.actualDirection,r.hit,r.retNextDayPct,r.atrPct].join(',')
      )).join('\n');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, csv);
    }
    if (errPath) {
      const header = 'symbol,date,pUp,decide,retNextDayPct,atrPct';
      const csv = [header].concat(aggWrongSimple.map(r =>
        [r.symbol,r.date,r.pUp,r.decide,r.retNextDayPct,r.atrPct].join(',')
      )).join('\n');
      fs.mkdirSync(path.dirname(errPath), { recursive: true });
      fs.writeFileSync(errPath, csv);

      // >>> EXPLAIN: write merged detailed diagnostics
      const detailedPath = errPath.includes('.csv')
        ? errPath.replace(/\.csv$/i, `.detailed.csv`)
        : `${errPath}.detailed.csv`;
      if (aggWrongDetailed.length) {
        writeWrongCsv(detailedPath, aggWrongDetailed);
        summarizeBlame(aggWrongDetailed);
        const blameAggPath = detailedPath.replace(/\.csv$/i, '.blame.csv');
        summarizeBlamePlus(aggWrongDetailed, blameAggPath);
        console.log(`Saved blame summary → ${blameAggPath}`);
        console.log(`Saved detailed wrong-trade diagnostics → ${detailedPath} (n=${aggWrongDetailed.length})`);
      }
    }

    const hits = aggPreds.reduce((s,r)=>s+(r.hit?1:0),0);
    console.log('\n====================\nAGGREGATE (all symbols)\n====================\n');
    console.log('Diagnostics');
    console.log('-----------');
    console.log(`Obs=${aggPreds.length}, Acc=${(hits/aggPreds.length*100).toFixed(2)}%`);
    if (outPath) console.log(`Saved predictions → ${outPath} (n=${aggPreds.length})`);
    if (errPath)  console.log(`Saved wrong-trade rows → ${errPath} (n=${aggWrongSimple.length})`);
  }
})();

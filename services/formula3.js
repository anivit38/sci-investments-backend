// backend/services/formula3.js
const { median, mad, zScoreMAD, sma, ema } = require('./math');
const {
  macd, rsi, atr, bollingerWidth, rvol,
  stochasticK, stochasticD, williamsR, cci,
  diPlusMinus, sar, linReg
} = require('./metrics');
const {
  compPercent, bucketTickerVol, bucketMarketVol,
  computeTickerVol, computeMarketVol
} = require('./volatility');
const { buildDominationSeries } = require('./domination');

/* ---------------- Z on prior data (t-L; t-1) ---------------- */ // :contentReference[oaicite:3]{index=3}
function zSeriesPrior(series) {
  return series.map((Xt, i) => {
    const past = series.slice(0, i).filter(Number.isFinite);
    if (!past.length) return NaN;
    return zScoreMAD(Xt, past);
  });
}
function nextDayMove(closes) { return closes.map((c,i)=> i<closes.length-1 ? (closes[i+1]>c?1:-1) : undefined); }
function nextDayPct(closes)  { return closes.map((c,i)=> i<closes.length-1 ? ((closes[i+1]-c)/c*100) : undefined); }

/* ---------------- Build all indicators ---------------- */
function buildAllFeatures(inputs) {
  const N = inputs.candles.length;
  const c = inputs.candles.map(x=>x.close);
  const h = inputs.candles.map(x=>x.high);
  const l = inputs.candles.map(x=>x.low);
  const v = inputs.candles.map(x=>x.volume);

  const bbw = bollingerWidth(c,20);
  const atrAbs = atr(h,l,c,14);
  const atrPct = atrAbs.map((x,i)=> x/(c[i]||1));
  const rvol20 = rvol(v,20);
  const iv = (inputs.impliedVol || Array(N).fill(NaN));

  const mac = macd(c);
  const rsi14 = rsi(c,14);
  const stochK = stochasticK(h,l,c,14);
  const stochD = stochasticD(stochK,3);
  const wpr = williamsR(h,l,c,14);
  const cci20 = cci(h,l,c,20);

  const roc1 = c.map((x,i)=> i? (x-c[i-1])/(c[i-1]||1) : NaN);
  const momentum10 = c.map((x,i)=> i>=10? (x - c[i-10]) : NaN);
  const { slope: ema20Slope } = linReg(ema(c,20), 20);
  const { plusDI, minusDI, adx } = diPlusMinus(h,l,c,14);
  const psar = sar(h,l,0.02,0.2);
  const { slope: priceSlope20, r2: priceR2_20 } = linReg(c,20);

  const sma20 = sma(c,20), ema20 = ema(c,20);
  const maSpread = ema(c,10).map((x,i)=> Number.isFinite(x)&&Number.isFinite(ema20[i]) ? x-ema20[i] : NaN);
  const priceMinusSMA20 = c.map((x,i)=> Number.isFinite(sma20[i]) ? (x - sma20[i])/(sma20[i]||1) : NaN);

  const z = {
    // TVol pieces
    bbw: zSeriesPrior(bbw),
    atrPct: zSeriesPrior(atrPct),
    rvol: zSeriesPrior(rvol20),
    iv: zSeriesPrior(iv),

    // Families
    macdLine: zSeriesPrior(mac.line),
    macdSig : zSeriesPrior(mac.signal),
    rsi14: zSeriesPrior(rsi14),
    stochK: zSeriesPrior(stochK),
    wpr: zSeriesPrior(wpr),
    cci20: zSeriesPrior(cci20),

    roc1: zSeriesPrior(roc1),
    mom10: zSeriesPrior(momentum10),
    ema20Slope: zSeriesPrior(ema20Slope),

    adx14: zSeriesPrior(adx),
    plusDI14: zSeriesPrior(plusDI),
    psarDist: zSeriesPrior(c.map((x,i)=> Number.isFinite(psar[i])? (x-psar[i])/(x||1) : NaN)),

    priceSlope20: zSeriesPrior(priceSlope20),
    priceR2_20: zSeriesPrior(priceR2_20),

    maSpread: zSeriesPrior(maSpread),
    priceMinusSMA20: zSeriesPrior(priceMinusSMA20),
  };

  return { N, c, h, l, v, z };
}

/* ---------------- 432 combos ---------------- */           // :contentReference[oaicite:4]{index=4}
const F1 = ['sma20','ema20','macdLine','macdSig','maSpread','priceMinusSMA20']; // 6
const F2 = ['rsi14','stochK','wpr','cci20'];                                     // 4
const F3 = ['roc1','mom10','ema20Slope'];                                        // 3
const F4 = ['adx14','plusDI14','psarDist'];                                      // 3
const F5 = ['priceSlope20','priceR2_20'];                                        // 2
function zKeyForF1(k){ if(k==='sma20')return 'priceMinusSMA20'; if(k==='ema20')return 'ema20Slope'; return k; }
function sumZ(z, keys, i){ return keys.reduce((s,k)=> s + (Number.isFinite(z[(F1.includes(k)?zKeyForF1(k):k)]?.[i]) ? z[(F1.includes(k)?zKeyForF1(k):k)][i] : 0), 0); }

/* ----- %SM by decile bins, tie-breaker: lowest avg (max% − min%) of majority %C ----- */ // :contentReference[oaicite:5]{index=5}
function evaluateCombo(z, closes) {
  const N = closes.length, y = nextDayMove(closes), pct = nextDayPct(closes);
  return function(keysForThisCombo){
    const S = Array(N).fill(NaN);
    for (let i=0;i<N;i++) S[i] = sumZ(z, keysForThisCombo, i);

    const idx = Array.from({length:N-1}, (_,i)=>i).filter(i=>Number.isFinite(S[i]) && Number.isFinite(y[i]));
    if (!idx.length) return null;

    const sorted = idx.sort((a,b)=> S[a]-S[b]);
    const n = sorted.length, gSize = Math.floor(n/10);
    const bins = [];
    let cursor = 0;
    for (let g=0; g<10; g++){
      const take = (g===9) ? (n-cursor) : gSize;
      if (take<=0) break;
      bins.push(sorted.slice(cursor, cursor+take));
      cursor += take;
    }

    const perBin = bins.map(arr=>{
      const ups = arr.filter(i=>y[i]===1), downs = arr.filter(i=>y[i]===-1);
      const maj = ups.length >= downs.length ? 1 : -1;
      const sm = (maj===1? ups.length : downs.length) / (arr.length||1);         // %SM   :contentReference[oaicite:6]{index=6}
      const majPct = arr.filter(i=>y[i]===maj).map(i=>pct[i]).filter(Number.isFinite);
      const rng = majPct.length ? (Math.max(...majPct) - Math.min(...majPct)) : 0; // tie-breaker range  :contentReference[oaicite:7]{index=7}
      return { sm, rng };
    });

    const avgSM = perBin.reduce((a,b)=>a+b.sm,0)/(perBin.length||1);
    const avgRangePct = perBin.reduce((a,b)=>a+b.rng,0)/(perBin.length||1);
    return { keys: keysForThisCombo, avgSM, avgRangePct };
  }
}
function selectBestCombo(z, closes){
  const evalFn = evaluateCombo(z, closes);
  const combos = [];
  for (const a of F1) for (const b of F2) for (const c of F3) for (const d of F4) for (const e of F5) {
    const res = evalFn([a,b,c,d,e]); if (res) combos.push(res);
  }
  combos.sort((x,y)=> y.avgSM - x.avgSM);
  const top = combos[0];
  const within3 = combos.filter(c=> (top.avgSM - c.avgSM) <= 0.03);              // within 3%  :contentReference[oaicite:8]{index=8}
  within3.sort((x,y)=> x.avgRangePct - y.avgRangePct);
  return within3[0];
}

/* ---------------- Volume/Sentiment/Volatility/ Domination ---------------- */
function compSeries(vals, n=20){
  const avg = vals.map((_,i)=> {
    const s = Math.max(0, i-(n-1)); const slice = vals.slice(s,i+1);
    return slice.reduce((a,b)=>a+b,0)/slice.length;
  });
  return vals.map((v,i)=> compPercent(v, avg[i]));
}
function buildVolSentDom(inputs){
  const N = inputs.candles.length;
  const c = inputs.candles.map(x=>x.close), h=inputs.candles.map(x=>x.high), l=inputs.candles.map(x=>x.low), v=inputs.candles.map(x=>x.volume);

  const compVolPct = compSeries(v,20);                                            // Volume column  :contentReference[oaicite:9]{index=9}
  const sent = (inputs.sentiment || Array(N).fill({score:NaN})).map(s=> s?.score ?? NaN);
  const compSentPct = compSeries(sent,20);                                        // Sentiment column  :contentReference[oaicite:10]{index=10}

  // Volume domination
  let domination = inputs.volumeDomination;                                       // "Buyer"|"Seller"|"Neutral"
  if (!domination && inputs.ticksByDayMap) {
    domination = buildDominationSeries(inputs.candles, inputs.ticksByDayMap);
  }

  // TVol & MVol with buckets → scores  :contentReference[oaicite:11]{index=11}
  const zBBW = zSeriesPrior(bollingerWidth(c,20));
  const zATR = zSeriesPrior(atr(h,l,c,14).map((x,i)=>x/(c[i]||1)));
  const zRVOL = zSeriesPrior(rvol(v,20));
  const zIV   = zSeriesPrior(inputs.impliedVol || Array(N).fill(NaN));
  const TVol  = zBBW.map((_,i)=> computeTickerVol(zBBW[i], zATR[i], zRVOL[i], zIV[i]));
  const avgTVol = sma(TVol.map(x=>Number.isFinite(x)?x:0),20);
  const TVolComp = TVol.map((v,i)=> Number.isFinite(avgTVol[i]) ? compPercent(v, avgTVol[i]) : NaN);
  const TVolBucket = TVolComp.map(x => Number.isFinite(x)? bucketTickerVol(x) : {label:'N/A',score:0});

  const zVIX = zSeriesPrior(inputs.vix || Array(N).fill(NaN));
  const zEPU = zSeriesPrior(inputs.epu || Array(N).fill(NaN));
  const zMDD = zSeriesPrior(inputs.mdd || Array(N).fill(NaN));
  const MVol = zVIX.map((_,i)=> computeMarketVol(zVIX[i], zEPU[i], zMDD[i]));
  const avgMVol = sma(MVol.map(x=>Number.isFinite(x)?x:0),20);
  const MVolComp = MVol.map((v,i)=> Number.isFinite(avgMVol[i]) ? compPercent(v, avgMVol[i]) : NaN);
  const MVolBucket = MVolComp.map(x => Number.isFinite(x)? bucketMarketVol(x) : {label:'N/A',score:0});

  return { compVolPct, compSentPct, TVolComp, TVolBucket, MVolComp, MVolBucket, domination };
}

/* ---------------- Ts & avgTs (AH/MO/MC/C) ---------------- */
// Your spec defines the averaging based on when we compute the score.  :contentReference[oaicite:12]{index=12}
// We support two modes: 'during' and 'after'. If phases for t and t-1 are supplied,
// we follow exactly; if not, we fall back to daily Ts.
function averageTsBySpec(currentDayRows, prevDayRows, mode /* 'during' | 'after' */) {
  if (!Array.isArray(currentDayRows) || !Array.isArray(prevDayRows)) return NaN;
  const map = (rows)=> Object.fromEntries(rows.map(r=> [r.phase, r.Ts]).filter(([_,v])=>Number.isFinite(v)));
  const cur = map(currentDayRows), prev = map(prevDayRows);
  if (mode === 'during') {
    const parts = [cur.MO, prev.MC, prev.AH, prev.MO, cur.C];                    // 5-term average  :contentReference[oaicite:13]{index=13}
    const arr = parts.filter(Number.isFinite);
    return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : NaN;
  } else {
    const parts = [prev.MC, prev.AH, prev.MO, cur.C];                             // 4-term average  :contentReference[oaicite:14]{index=14}
    const arr = parts.filter(Number.isFinite);
    return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : NaN;
  }
}

/* ---------------- Full pipeline ---------------- */
function runFullFormula(inputs){
  const { N, c, z } = buildAllFeatures(inputs);
  const best = selectBestCombo(z, c);                                             // 432 + tie-breaker  :contentReference[oaicite:15]{index=15}
  const { compVolPct, compSentPct, TVolComp, TVolBucket, MVolComp, MVolBucket, domination } = buildVolSentDom(inputs);

  // Score = sum of z's for best combo  :contentReference[oaicite:16]{index=16}
  const Score = Array(N).fill(NaN);
  for (let i=0;i<N;i++) Score[i] = sumZ(z, best.keys, i);

  // Ts per index (row) = Score + CompVol% + CompSent% + TVolBucketScore + MVolBucketScore  :contentReference[oaicite:17]{index=17}
  const Ts = Array(N).fill(NaN);
  for (let i=0;i<N;i++){
    const compV = Number.isFinite(compVolPct[i]) ? compVolPct[i] : 0;
    const compS = Number.isFinite(compSentPct[i]) ? compSentPct[i] : 0;
    const tB = TVolBucket[i]?.score ?? 0;
    const mB = MVolBucket[i]?.score ?? 0;
    Ts[i] = (Score[i]||0) + compV + compS + tB + mB;
  }

  // avgTs per calendar day per your AH/MO/MC/C rule
  // If you pass inputs.dayRows = [{date:'YYYY-MM-DD', rows:[{phase:'AH'|'MO'|'MC'|'C', idx}]}, ...]
  // we compute exact averages; else fallback to Ts.
  const avgTs = Ts.slice();
  if (Array.isArray(inputs.dayRows) && inputs.dayRows.length >= 2) {
    for (let d = 1; d < inputs.dayRows.length; d++) {
      const cur = inputs.dayRows[d];
      const prev = inputs.dayRows[d-1];
      const mode = inputs.mode === 'during' ? 'during' : 'after';
      // attach Ts to each row
      const rowsWithTs = cur.rows.map(r => ({...r, Ts: Ts[r.idx]}));
      const prevRowsTs = prev.rows.map(r => ({...r, Ts: Ts[r.idx]}));
      const val = averageTsBySpec(rowsWithTs, prevRowsTs, mode);
      // set avgTs for all indices of the current day to same avg
      for (const r of rowsWithTs) avgTs[r.idx] = val;
    }
  }

  return {
    bestCombo: best,
    snapshot: {
      date: inputs.candles[N-1].t,
      domination: domination?.[N-1] ?? null,                                     // "Buyer"/"Seller"/"Neutral"
      Score: Score[N-1],
      compVolPct: compVolPct[N-1],
      compSentPct: compSentPct[N-1],
      TVolComp: TVolComp[N-1], TVolBucket: TVolBucket[N-1],
      MVolComp: MVolComp[N-1], MVolBucket: MVolBucket[N-1],
      Ts: Ts[N-1], avgTs: avgTs[N-1]
    },
    series: { Score, Ts, avgTs, domination }
  };
}

/* ---------------- Similarity & Prediction (strict) ---------------- */
// Gate 1: avgTs within ±3 (widen to 10 if needed)  :contentReference[oaicite:18]{index=18}
// Gate 2: vector distance on [Score, %CompVol, %CompSent, TVolComp, MVolComp] must be among k-nearest.
function predictNextDay(inputs) {
  const ff = runFullFormula(inputs);
  const { Score, avgTs } = ff.series;
  const N = inputs.candles.length;
  const today = {
    avgTs: avgTs[N-1],
    Score: Score[N-1],
  };
  const comp = buildVolSentDom(inputs); // rebuild for access to comps
  const curVec = [
    today.Score,
    comp.compVolPct[N-1],
    comp.compSentPct[N-1],
    comp.TVolComp[N-1],
    comp.MVolComp[N-1],
  ];

  const closes = inputs.candles.map(x=>x.close);
  const label = nextDayMove(closes);
  const pct = nextDayPct(closes);

  // Gate 1: Ts band
  let band = 3;
  let candIdx = [];
  while (candIdx.length < 50 && band <= 10) {
    candIdx = avgTs
      .map((v,i)=>({i,v}))
      .filter(o=> o.i < N-1 && Number.isFinite(o.v) && Math.abs(o.v - today.avgTs) <= band)
      .map(o=>o.i);
    band++;
  }
  if (!candIdx.length) {
    return { ...ff, prediction: { prediction:'Unknown', confidence:0, estPctChange:0, matches:0, bandUsed: band-1 } };
  }

  // Gate 2: kNN on vector differences
  function vec(i){
    return [
      Score[i],
      comp.compVolPct[i],
      comp.compSentPct[i],
      comp.TVolComp[i],
      comp.MVolComp[i],
    ];
  }
  function dist(a,b){ let s=0; for (let k=0;k<a.length;k++){ const da=a[k], db=b[k]; if (Number.isFinite(da)&&Number.isFinite(db)) s += (da-db)*(da-db); } return Math.sqrt(s); }

  const ranked = candIdx
    .map(i => ({ i, d: dist(curVec, vec(i)) }))
    .sort((x,y)=> x.d - y.d);

  const K = Math.min(100, ranked.length); // use up to 100 nearest
  const nn = ranked.slice(0,K).map(r=>r.i);

  const ups = nn.filter(i=>label[i]===1).length;
  const downs = nn.filter(i=>label[i]===-1).length;
  const total = ups + downs;
  const predUp = ups >= downs;
  const estPct = nn.map(i=>pct[i]).filter(Number.isFinite).reduce((a,b)=>a+b,0) / (nn.length||1);

  return {
    ...ff,
    prediction: {
      prediction: predUp ? 'Up' : 'Down',
      confidence: total ? Math.max(ups,downs)/total : 0,
      estPctChange: estPct,
      matches: nn.length,
      bandUsed: band-1
    }
  };
}

module.exports = { runFullFormula, predictNextDay };

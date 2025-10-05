// backend/services/metrics.js
const { sma, ema, median } = require('./math');

/* ---------- Existing MACD/RSI/ATR/RVOL/BBW (keep yours) ---------- */
function macd(close, fast=12, slow=26, sig=9) {
  const emaF = ema(close, fast);
  const emaS = ema(close, slow);
  const line = close.map((_, i) =>
    Number.isFinite(emaF[i]) && Number.isFinite(emaS[i]) ? (emaF[i] - emaS[i]) : NaN
  );
  const signal = ema(line.map(x => Number.isFinite(x) ? x : 0), sig);
  const hist = line.map((x, i) => (Number.isFinite(x) && Number.isFinite(signal[i])) ? (x - signal[i]) : NaN);
  return { line, signal, hist };
}

function rsi(close, n=14) {
  if (close.length < n + 1) return Array(close.length).fill(NaN);
  const gains = [], losses = [];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i-1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const emaG = ema(gains, n), emaL = ema(losses, n);
  const out = Array(close.length).fill(NaN);
  for (let i = 1; i < close.length; i++) {
    const rg = emaG[i-1], rl = emaL[i-1];
    if (!Number.isFinite(rg) || !Number.isFinite(rl)) continue;
    const rs = rl === 0 ? 100 : rg / rl;
    out[i] = 100 - (100 / (1 + rs));
  }
  return out;
}

function atr(high, low, close, n=14) {
  const tr = Array(close.length).fill(NaN);
  for (let i = 0; i < close.length; i++) {
    if (i === 0) continue;
    const a = high[i] - low[i];
    const b = Math.abs(high[i] - close[i-1]);
    const c = Math.abs(low[i] - close[i-1]);
    tr[i] = Math.max(a, b, c);
  }
  return ema(tr.map(x => Number.isFinite(x) ? x : 0), n);
}

function bollingerWidth(close, n=20, k=2) {
  const ma = sma(close, n);
  const out = Array(close.length).fill(NaN);
  for (let i = 0; i < close.length; i++) {
    if (i < n - 1) continue;
    const slice = close.slice(i-n+1, i+1);
    const m = ma[i];
    const variance = slice.reduce((s, v) => s + (v - m) ** 2, 0) / n;
    const sd = Math.sqrt(variance);
    const upper = m + k*sd, lower = m - k*sd;
    out[i] = (upper - lower) / (m || 1);
  }
  return out;
}

function rvol(volume, n=20) {
  const avg = sma(volume, n);
  return volume.map((v, i) => Number.isFinite(avg[i]) ? (v / (avg[i] || 1)) : NaN);
}

/* ---------- New: Stochastic, Williams %R, CCI ---------- */
function stochasticK(high, low, close, n=14) {
  return close.map((c, i) => {
    if (i < n-1) return NaN;
    const hh = Math.max(...high.slice(i-n+1, i+1));
    const ll = Math.min(...low.slice(i-n+1, i+1));
    return (hh === ll) ? NaN : ((c - ll) / (hh - ll)) * 100;
  });
}
function stochasticD(kArr, m=3) {
  const out = Array(kArr.length).fill(NaN);
  for (let i = 0; i < kArr.length; i++) {
    if (i < m-1) continue;
    const slice = kArr.slice(i-m+1, i+1).filter(Number.isFinite);
    out[i] = slice.length ? slice.reduce((a,b)=>a+b,0)/slice.length : NaN;
  }
  return out;
}
function williamsR(high, low, close, n=14) {
  return close.map((c, i) => {
    if (i < n-1) return NaN;
    const hh = Math.max(...high.slice(i-n+1, i+1));
    const ll = Math.min(...low.slice(i-n+1, i+1));
    return (hh === ll) ? NaN : ( (hh - c) / (hh - ll) ) * -100;
  });
}
function cci(high, low, close, n=20) {
  const tp = close.map((c,i) => (high[i]+low[i]+c)/3);
  const smaTp = sma(tp, n);
  return tp.map((t, i) => {
    if (i < n-1) return NaN;
    const mean = smaTp[i];
    const slice = tp.slice(i-n+1, i+1);
    const md = slice.reduce((a,v)=>a+Math.abs(v-mean),0)/n;
    return md === 0 ? NaN : (t - mean) / (0.015 * md);
  });
}

/* ---------- New: ADX, +DI/-DI ---------- */
function diPlusMinus(high, low, close, n=14) {
  const len = close.length;
  const plusDM = Array(len).fill(0), minusDM = Array(len).fill(0), tr = Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    const upMove = high[i] - high[i-1];
    const downMove = low[i-1] - low[i];
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    const range = Math.max(high[i]-low[i], Math.abs(high[i]-close[i-1]), Math.abs(low[i]-close[i-1]));
    tr[i] = range;
  }
  const atrN = ema(tr, n);
  const plusDI = plusDM.map((v,i)=> atrN[i] ? (100 * ema(plusDM, n)[i] / atrN[i]) : NaN);
  const minusDI = minusDM.map((v,i)=> atrN[i] ? (100 * ema(minusDM, n)[i] / atrN[i]) : NaN);
  const dx = plusDI.map((p,i)=>{
    const m = minusDI[i];
    return (Number.isFinite(p) && Number.isFinite(m) && (p+m)!==0) ? (100 * Math.abs(p-m)/(p+m)) : NaN;
  });
  const adx = ema(dx.map(x => Number.isFinite(x)?x:0), n);
  return { plusDI, minusDI, adx };
}

/* ---------- New: Parabolic SAR ---------- */
function sar(high, low, step=0.02, maxStep=0.2) {
  const len = high.length;
  const out = Array(len).fill(NaN);
  if (len < 2) return out;
  let isUp = true; // start guess
  let af = step;
  let ep = high[0];
  let sarVal = low[0];
  for (let i = 1; i < len; i++) {
    sarVal = sarVal + af * (ep - sarVal);
    if (isUp) {
      sarVal = Math.min(sarVal, low[i-1], low[i]);
      if (high[i] > ep) { ep = high[i]; af = Math.min(maxStep, af + step); }
      if (low[i] < sarVal) { isUp = false; sarVal = ep; ep = low[i]; af = step; }
    } else {
      sarVal = Math.max(sarVal, high[i-1], high[i]);
      if (low[i] < ep) { ep = low[i]; af = Math.min(maxStep, af + step); }
      if (high[i] > sarVal) { isUp = true; sarVal = ep; ep = high[i]; af = step; }
    }
    out[i] = sarVal;
  }
  return out;
}

/* ---------- New: Regression slope & R² over window n ---------- */
function linReg(y, n=20) {
  const outSlope = Array(y.length).fill(NaN);
  const outR2 = Array(y.length).fill(NaN);
  for (let i = 0; i < y.length; i++) {
    if (i < n-1) continue;
    const xs = Array.from({length:n}, (_,k)=>k);
    const ys = y.slice(i-n+1, i+1);
    const xMean = (n-1)/2;
    const yMean = ys.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0, ssTot=0, ssRes=0;
    for (let k = 0; k < n; k++) {
      num += (xs[k]-xMean)*(ys[k]-yMean);
      den += (xs[k]-xMean)**2;
    }
    const slope = den ? num/den : NaN;
    const intercept = yMean - slope*xMean;
    for (let k = 0; k < n; k++) {
      const pred = intercept + slope*xs[k];
      ssTot += (ys[k]-yMean)**2;
      ssRes += (ys[k]-pred)**2;
    }
    const r2 = ssTot ? 1 - ssRes/ssTot : NaN;
    outSlope[i] = slope;
    outR2[i] = r2;
  }
  return { slope: outSlope, r2: outR2 };
}

module.exports = {
  macd, rsi, atr, bollingerWidth, rvol,
  stochasticK, stochasticD, williamsR, cci,
  diPlusMinus, sar, linReg
};

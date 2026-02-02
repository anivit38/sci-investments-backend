// backend/scripts/backtest-formula3.js
// Backtests YOUR next-day classifier over daily candles (no peeking).
// Usage:
//   node scripts/backtest-formula3.js AAPL 2023-01-01 2024-12-31
//   node scripts/backtest-formula3.js AAPL,MSFT 2022-01-01 2025-01-01

'use strict';

const fs = require('fs');
const path = require('path');
const yf = require('yahoo-finance2').default;
const { predictNextDay } = require('../services/formula3');

function toISO(d){ return (d instanceof Date ? d : new Date(d)).toISOString().slice(0,10); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Robust Yahoo fetch with retries & jitter.
 * Returns: [{ t:'YYYY-MM-DD', open, high, low, close, volume }, ...]
 */
async function fetchDailyWithRetry(symbol, fromISO, toISO, maxAttempts = 6) {
  const period1 = new Date(fromISO);
  const period2 = new Date(toISO);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await yf.chart(symbol, { period1, period2, interval: '1d' });

      const quotes = res?.quotes || [];
      return quotes.map(q => ({
        t: q.date.toISOString().slice(0,10),
        open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0,
      })).filter(r => Number.isFinite(r.close));
    } catch (e) {
      if (attempt === maxAttempts) {
        console.error(`❌ ${symbol} fetch failed after ${maxAttempts} attempts:`, e.code || e.message);
        throw e;
      }
      const wait = Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      console.warn(`⚠️  ${symbol} fetch failed (attempt ${attempt}/${maxAttempts}: ${e.code || e.message}). Retrying in ${wait}ms…`);
      await sleep(wait);
    }
  }
}

// ----- Metrics / summary helpers -----
function summarize(rows) {
  const tot = rows.length;
  const decided = rows.filter(r => r.predLabel !== 'Neutral');
  const correct = decided.filter(r => r.predLabel === r.trueLabel);
  const acc_all = correct.length / (decided.length || 1);

  const by = (lab) => {
    const took = decided.filter(r => r.predLabel === lab);
    const hit  = took.filter(r => r.predLabel === r.trueLabel);
    return { n:took.length, acc: took.length ? hit.length/took.length : 0 };
  };
  const up   = by('Up');
  const down = by('Down');

  const avgRetUp   = decided.filter(r=>r.predLabel==='Up')
    .reduce((s,r)=>s+(r.trueRet||0),0) / (up.n || 1);

  // Treat correct Down as + (short)
  const avgRetDown = decided.filter(r=>r.predLabel==='Down')
    .reduce((s,r)=>s-(r.trueRet||0),0) / (down.n || 1);

  // Calibration buckets by probUp deciles
  const buckets = Array.from({length:10},()=>({n:0, up:0}));
  for (const r of decided) {
    const b = Math.max(0, Math.min(9, Math.floor((r.probUp||0)*10)));
    buckets[b].n++;
    if (r.trueLabel==='Up') buckets[b].up++;
  }
  const calib = buckets.map((b,i)=>({
    bucket:`[${(i/10).toFixed(1)},${((i+1)/10).toFixed(1)})`,
    n:b.n,
    freqUp: b.n ? +(b.up/b.n).toFixed(3) : null
  }));

  return {
    totals: { points: tot, decided: decided.length, neutral: tot - decided.length },
    accuracy_when_decided: +acc_all.toFixed(3),
    up:   { n: up.n,   acc: +up.acc.toFixed(3),   avgNextDayRet: +avgRetUp.toFixed(5) },
    down: { n: down.n, acc: +down.acc.toFixed(3), avgNextDayRet: +avgRetDown.toFixed(5) },
    calibration: calib
  };
}

async function runOne(ticker, startISO, endISO) {
  const daily = await fetchDailyWithRetry(ticker, startISO, endISO);
  if (daily.length < 60) {
    return { ticker, error: `not enough data (${daily.length})` };
  }

  const rows = [];
  for (let t = 39; t < daily.length - 1; t++) { // need ≥40 bars to start
    const inCandles = daily.slice(0, t + 1);  // up to today (no peeking)

    const out = predictNextDay({
      candles: inCandles,
      sentiment: Array(inCandles.length).fill({score:0}),
      impliedVol: Array(inCandles.length).fill(NaN),
      vix: Array(inCandles.length).fill(NaN),
      epu: Array(inCandles.length).fill(NaN),
      mdd: Array(inCandles.length).fill(NaN),
      mode: 'during'
    });

    const today = daily[t];
    const tomorrow = daily[t+1];
    const trueRet = (tomorrow.close - today.close) / (today.close || 1);
    const trueLabel = tomorrow.close > today.close ? 'Up' : 'Down';
    const predLabel = out.prediction.label;
    const probUp = out.prediction.probUp;

    rows.push({
      date: today.t,
      predLabel, probUp,
      trueLabel, trueRet
    });
  }

  const summary = summarize(rows);

  // Write CSV for inspection
  const outDir = path.join(__dirname, '..', 'out');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, `formula3_backtest_${ticker}_${startISO}_${endISO}.csv`);
  const header = 'date,predLabel,probUp,trueLabel,trueRet\n';
  fs.writeFileSync(csvPath, header + rows.map(r =>
    [r.date, r.predLabel, (r.probUp??'').toString(), r.trueLabel, r.trueRet.toFixed(6)].join(',')
  ).join('\n'));

  return { ticker, summary, csv: csvPath };
}

(async () => {
  try {
    const [ tickersArg, from = '2020-01-01', to = toISO(new Date()) ] = process.argv.slice(2);
    if (!tickersArg) {
      console.error('Usage: node scripts/backtest-formula3.js AAPL 2023-01-01 2024-12-31');
      process.exit(1);
    }
    const tickers = tickersArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    const results = [];
    for (const tk of tickers) {
      console.log(`\n► Backtesting ${tk} from ${from} to ${to} …`);
      results.push(await runOne(tk, from, to));
      // small pause helps avoid undici/ECONNABORTED on Windows
      await sleep(400 + Math.floor(Math.random() * 300));
    }

    console.log('\n===== SUMMARY =====');
    for (const r of results) {
      if (r.error) { console.log(r.ticker, '→', r.error); continue; }
      console.log(r.ticker, JSON.stringify(r.summary, null, 2));
      console.log('CSV:', r.csv);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();

// Usage:
//   node scripts/export-lstm-dataset.js AAPL,MSFT,NVDA 730
//
// Writes: backend/datasets/lstm_dataset.csv
//
// Notes:
// - Direction label = 1 if next day's close > today's close else 0
// - Uses your runFullFormula() to get series: Score, Ts, avgTs, compVolPct, compSentPct, TVolComp, MVolComp
// - Adds basic price/volume context (close, volume, returns)

const fs = require('fs');
const path = require('path');
const yf = require('yahoo-finance2').default;

const { runFullFormula } = require('../services/formula3');
const { fetchVIXAligned } = require('./util-market'); // we added earlier

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = v => (v == null ? '' : String(v).includes(',') ? `"${String(v).replace(/"/g,'""')}"` : String(v));
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

async function getDailyCandles(ticker, daysBack = 730) {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const res = await yf.chart(ticker, { period1, period2, interval: '1d' });
  const quotes = (res?.quotes || []);
  return quotes.map(q => ({
    t: q.date.toISOString().slice(0,10),
    open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
  }));
}

function nextDayUp(closes, i) {
  if (i >= closes.length - 1) return undefined;
  return (closes[i + 1] > closes[i]) ? 1 : 0;
}

async function exportForTickers(tickers, daysBack) {
  const all = [];

  for (const ticker of tickers) {
    console.log(`Exporting ${ticker}...`);
    const candles = await getDailyCandles(ticker, daysBack);
    if (candles.length < 60) {
      console.warn(`  -> too few days (${candles.length}), skipping`);
      continue;
    }

    // minimal market series: real VIX; keep others NaN (treated as 0 in your pipeline)
    const vix = await fetchVIXAligned(candles);
    const inputs = {
      candles,
      sentiment: Array(candles.length).fill({ score: 0 }),
      impliedVol: Array(candles.length).fill(NaN),
      vix,
      epu: Array(candles.length).fill(NaN),
      mdd: Array(candles.length).fill(NaN),
      // no dayRows for history; avgTs falls back to Ts (correct for long history)
    };

    const out = runFullFormula(inputs);
    const S = out.series?.Score || [];
    const Ts = out.series?.Ts || [];
    const avgTs = out.series?.avgTs || [];
    const closes = candles.map(c => c.close);
    const vols = candles.map(c => c.volume);

    // % change (t-1 -> t) for simple price context
    const ret1 = closes.map((c, i) => i ? ((c - closes[i-1]) / (closes[i-1] || 1) * 100) : 0);

    for (let i = 0; i < candles.length - 1; i++) {
      all.push({
        date: candles[i].t,
        ticker,
        // label
        y_up: nextDayUp(closes, i),

        // core features from your formula
        Score: Number.isFinite(S[i]) ? S[i] : '',
        Ts: Number.isFinite(Ts[i]) ? Ts[i] : '',
        avgTs: Number.isFinite(avgTs[i]) ? avgTs[i] : '',
        compVolPct: Number.isFinite(out.series?.compVolPct?.[i]) ? out.series.compVolPct[i] : '',
        compSentPct: Number.isFinite(out.series?.compSentPct?.[i]) ? out.series.compSentPct[i] : '',
        TVolComp: Number.isFinite(out.series?.TVolComp?.[i]) ? out.series.TVolComp[i] : '',
        MVolComp: Number.isFinite(out.series?.MVolComp?.[i]) ? out.series.MVolComp[i] : '',

        // simple context
        close: closes[i],
        volume: vols[i],
        ret1: ret1[i]
      });
    }
  }

  const outDir = path.join(__dirname, '..', 'datasets');
  ensureDir(outDir);
  const outPath = path.join(outDir, 'lstm_dataset.csv');
  fs.writeFileSync(outPath, toCSV(all));
  console.log(`\nSaved ${outPath} with ${all.length} rows.`);
}

(async () => {
  const tickersArg = process.argv[2] || 'AAPL,MSFT,NVDA,AMZN,GOOGL,TSLA';
  const daysBack = Number(process.argv[3] || '1095'); // ~3y
  const tickers = tickersArg.split(',').map(s => s.trim()).filter(Boolean);
  await exportForTickers(tickers, daysBack);
})();

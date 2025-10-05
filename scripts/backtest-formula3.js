// Usage:
//   node scripts/backtest-formula3.js AAPL,MSFT,NVDA,AMZN,GOOGL,TSLA 730 120
//
// Args:
//   tickers (comma-separated)  default: AAPL,MSFT,NVDA,AMZN,GOOGL,TSLA
//   daysBack (int)             default: 730  (~2y)
//   warmup (int)               default: 120 (must be >= longest lookback)
//
// Output files (written to backend/backtests):
//   preds.csv
//   wrong.csv
//   wrong.detailed.csv
//   wrong.detailed.blame.csv

const fs = require('fs');
const path = require('path');
const yf = require('yahoo-finance2').default;

const { predictNextDay } = require('../services/formula3');
const { fetchVIXAligned } = require('./util-market');

// ---------- IO helpers ----------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = v =>
    v == null ? '' :
    String(v).includes(',') ? `"${String(v).replace(/"/g,'""')}"` :
    String(v);
  return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
}

// ---------- market data ----------
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

function nextDayMove(closes, i) {
  if (i >= closes.length - 1) return undefined;
  return closes[i + 1] > closes[i] ? 1 : -1;
}

function pctChange(closes, i) {
  if (i >= closes.length - 1) return undefined;
  return (closes[i + 1] - closes[i]) / (closes[i] || 1) * 100;
}

// ---------- core ----------
async function backtestTicker(ticker, daysBack, warmup) {
  const candles = await getDailyCandles(ticker, daysBack);
  if (candles.length < warmup + 2) {
    throw new Error(`${ticker}: not enough daily data (have ${candles.length}, need ${warmup + 2})`);
  }
  const vix = await fetchVIXAligned(candles);

  const closes = candles.map(c => c.close);
  const rows = [];

  for (let i = warmup; i < candles.length - 1; i++) {
    // only data up to i (no leakage)
    const slice = {
      candles: candles.slice(0, i + 1),
      // keep the stubs; our volatility helpers treat NaN as 0 so TVol/MVol still compute
      sentiment: Array(i + 1).fill({ score: 0 }),
      impliedVol: Array(i + 1).fill(NaN),
      vix: vix.slice(0, i + 1),
      epu: Array(i + 1).fill(NaN),
      mdd: Array(i + 1).fill(NaN),
      // no dayRows for history (minute limits) → avgTs fallback to Ts
    };

    const out = predictNextDay(slice);
    const pred = out.prediction || {};
    const actual = nextDayMove(closes, i);
    const actualPct = pctChange(closes, i);

    rows.push({
      date: candles[i].t,
      ticker,
      pred_dir: pred.prediction || 'Unknown',
      pred_conf: pred.confidence ?? '',
      pred_est_pct: pred.estPctChange ?? '',
      matches: pred.matches ?? '',
      band_used: pred.bandUsed ?? '',
      score: out.snapshot?.Score ?? '',
      Ts: out.snapshot?.Ts ?? '',
      avgTs: out.snapshot?.avgTs ?? '',
      compVolPct: out.snapshot?.compVolPct ?? '',
      compSentPct: out.snapshot?.compSentPct ?? '',
      tv_comp: out.snapshot?.TVolComp ?? '',
      mv_comp: out.snapshot?.MVolComp ?? '',
      actual_dir: actual === 1 ? 'Up' : (actual === -1 ? 'Down' : ''),
      actual_pct: actualPct ?? '',
      correct: (pred.prediction === (actual === 1 ? 'Up' : 'Down')) ? 1 : 0
    });
  }

  return rows;
}

async function main() {
  const tickersArg = process.argv[2] || 'AAPL,MSFT,NVDA,AMZN,GOOGL,TSLA';
  const daysArg = Number(process.argv[3] || '730'); // ~2y
  const warmupArg = Number(process.argv[4] || '120');

  const tickers = tickersArg.split(',').map(s => s.trim()).filter(Boolean);

  const all = [];
  for (const t of tickers) {
    console.log(`Backtesting ${t}...`);
    try {
      const rows = await backtestTicker(t, daysArg, warmupArg);
      all.push(...rows);
      const tested = rows.filter(r => r.pred_dir !== 'Unknown').length;
      const acc = tested ? rows.filter(r => r.correct === 1).length / tested : 0;
      console.log(`  -> ${tested} preds, accuracy ${(acc*100).toFixed(1)}%`);
    } catch (e) {
      console.error(`  -> ERROR for ${t}: ${e.message}`);
    }
  }

  // Write outputs where your folder expects them
  const outDir = path.join(__dirname, '..', 'backtests');
  ensureDir(outDir);

  const predsPath = path.join(outDir, 'preds.csv');
  fs.writeFileSync(predsPath, toCSV(all));
  console.log(`Saved ${predsPath}`);

  // mistakes (summary & detailed)
  const wrong = all.filter(r => r.pred_dir !== 'Unknown' && r.correct === 0)
                   .map(r => ({ date: r.date, ticker: r.ticker, pred_dir: r.pred_dir, actual_dir: r.actual_dir }));
  const wrongPath = path.join(outDir, 'wrong.csv');
  fs.writeFileSync(wrongPath, toCSV(wrong));
  console.log(`Saved ${wrongPath}`);

  const wrongDetailed = all.filter(r => r.pred_dir !== 'Unknown' && r.correct === 0);
  const wrongDetailedPath = path.join(outDir, 'wrong.detailed.csv');
  fs.writeFileSync(wrongDetailedPath, toCSV(wrongDetailed));
  console.log(`Saved ${wrongDetailedPath}`);

  // “blame” — what features the model saw when it was wrong
  const blame = wrongDetailed.map(r => ({
    date: r.date,
    ticker: r.ticker,
    score: r.score,
    Ts: r.Ts,
    avgTs: r.avgTs,
    compVolPct: r.compVolPct,
    compSentPct: r.compSentPct,
    tv_comp: r.tv_comp,
    mv_comp: r.mv_comp,
    matches: r.matches,
    band_used: r.band_used,
    pred_dir: r.pred_dir,
    actual_dir: r.actual_dir,
    pred_conf: r.pred_conf,
    pred_est_pct: r.pred_est_pct,
    actual_pct: r.actual_pct
  }));
  const blamePath = path.join(outDir, 'wrong.detailed.blame.csv');
  fs.writeFileSync(blamePath, toCSV(blame));
  console.log(`Saved ${blamePath}`);
}

main().catch(e => { console.error(e); process.exit(1); });

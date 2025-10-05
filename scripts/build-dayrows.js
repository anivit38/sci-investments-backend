const { buildDayRowsFromYahoo } = require('../services/intradayPhases');
const { attachDayRowsToDaily } = require('../services/attachDayRows');
const { predictNextDay } = require('../services/formula3');
const yf = require('yahoo-finance2').default;
const { fetchVIXAligned } = require('./util-market');

async function getDailyCandles(ticker, monthsBack = 12) {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - monthsBack * 30 * 24 * 60 * 60 * 1000);
  const res = await yf.chart(ticker, { period1, period2, interval: '1d' });
  return (res?.quotes||[]).map(q => ({
    t: q.date.toISOString().slice(0,10),
    open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
  }));
}

(async () => {
  try {
    const ticker = process.argv[2] || 'AAPL';
    const daily = await getDailyCandles(ticker, 12);

    // NEW: real VIX series aligned to daily length
    const vix = await fetchVIXAligned(daily);

    const { dayRows } = await buildDayRowsFromYahoo(ticker, { days1m: 7, days5m: 30 });
    const attached = attachDayRowsToDaily(dayRows, daily);

    const inputs = {
      candles: daily,
      sentiment: Array(daily.length).fill({ score: 0 }), // leave as is for now
      impliedVol: Array(daily.length).fill(NaN),         // IV unknown → treated as 0 in TVol
      vix,                                               // ← real
      epu: Array(daily.length).fill(NaN),                // optional
      mdd: Array(daily.length).fill(NaN),                // optional
      mode: 'during',
      dayRows: attached
    };

    const out = predictNextDay(inputs);
    console.log('DAY ROWS (last 3):', attached.slice(-3));
    console.log('PREDICTION:', out.prediction);
    console.log('SNAPSHOT:', out.snapshot);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();

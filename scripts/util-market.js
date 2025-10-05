const yf = require('yahoo-finance2').default;

async function fetchVIXAligned(dailyCandles) {
  const start = new Date(dailyCandles[0].t);
  const end   = new Date(dailyCandles[dailyCandles.length - 1].t);
  const res = await yf.chart('^VIX', { period1: start, period2: end, interval: '1d' });
  const map = new Map((res?.quotes || []).map(q => [q.date.toISOString().slice(0,10), q.close]));
  return dailyCandles.map(d => map.get(d.t) ?? NaN);
}

module.exports = { fetchVIXAligned };

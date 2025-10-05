// backend/services/attachDayRows.js
// Map {date:'YYYY-MM-DD', rows:[{phase,t,close}]} to {phase, idx} using your daily candles array.

const dayjs = require('dayjs');
const tz = require('dayjs/plugin/timezone'); const utc = require('dayjs/plugin/utc');
dayjs.extend(utc); dayjs.extend(tz);

function toDateStrNY(ts, zone='America/New_York') { return dayjs(ts).tz(zone).format('YYYY-MM-DD'); }

function attachDayRowsToDaily(dayRows, dailyCandles, zone='America/New_York') {
  // dailyCandles: [{t:'YYYY-MM-DD' or Date, open, high, low, close, volume}, ...] oldest->newest
  const indexByDate = new Map();
  dailyCandles.forEach((c, i) => {
    const key = typeof c.t === 'string' ? c.t.slice(0,10) : toDateStrNY(c.t, zone);
    indexByDate.set(key, i);
  });

  const out = [];
  for (const d of dayRows) {
    const idx = indexByDate.get(d.date);
    if (idx == null) continue; // daily series may not cover this day
    const rows = d.rows.map(r => ({ phase: r.phase, idx }));
    out.push({ date: d.date, rows });
  }
  return out;
}

module.exports = { attachDayRowsToDaily };

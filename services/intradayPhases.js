// backend/services/intradayPhases.js
const yf = require('yahoo-finance2').default;
const dayjs = require('dayjs');
const tz = require('dayjs/plugin/timezone'); const utc = require('dayjs/plugin/utc');
dayjs.extend(utc); dayjs.extend(tz);

const NY = 'America/New_York';
const OPEN  = { h:  9, m: 30 };
const CLOSE = { h: 16, m:  0 };

function isSameDayNY(a, b) {
  const da = dayjs(a).tz(NY), db = dayjs(b).tz(NY);
  return da.year()===db.year() && da.month()===db.month() && da.date()===db.date();
}
function tsNY(y,m,d,h,mm){ return dayjs.tz({ year:y, month:m, day:d, hour:h, minute:mm, second:0, millisecond:0 }, NY); }

function pickPhasesForDayNY(bars, dateNY) {
  const y = dateNY.year(), m = dateNY.month()+1, d = dateNY.date();
  const openCut  = tsNY(y, m-1, d, OPEN.h, OPEN.m);
  const closeCut = tsNY(y, m-1, d, CLOSE.h, CLOSE.m);

  const dayBars = bars.filter(b => isSameDayNY(b.date, dateNY));
  if (!dayBars.length) return null;

  const pre = dayBars.filter(b => dayjs(b.date).tz(NY).isBefore(openCut));
  const AH  = pre.length ? pre[pre.length - 1] : null;

  const MO = dayBars.find(b => !dayjs(b.date).tz(NY).isBefore(openCut)) || null;

  const mcCand = dayBars.filter(b => !dayjs(b.date).tz(NY).isAfter(closeCut));
  const MC = mcCand.length ? mcCand[mcCand.length - 1] : null;

  const C  = dayBars[dayBars.length - 1] || null;

  return { AH, MO, MC, C };
}

/**
 * Fetch intraday bars via explicit period1/period2 to avoid "range" validation issues.
 * - Try 1m for the last 7 days (Yahoo’s limit).
 * - If empty/fails, fall back to 5m for the last ~30 days.
 */
async function buildDayRowsFromYahoo(ticker, { days1m = 7, days5m = 30 } = {}) {
  const now = new Date();
  const p1_1m = new Date(now.getTime() - days1m * 24 * 60 * 60 * 1000);
  const p1_5m = new Date(now.getTime() - days5m * 24 * 60 * 60 * 1000);

  async function fetchChart(period1, period2, interval) {
    return yf.chart(ticker, {
      period1, period2,
      interval, includePrePost: true
    });
  }

  let res = null;
  try {
    res = await fetchChart(p1_1m, now, '1m');
  } catch { /* ignore */ }

  if (!res?.quotes?.length) {
    res = await fetchChart(p1_5m, now, '5m');
  }
  const bars = (res?.quotes || []).map(q => ({
    date: new Date(q.date),
    open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
  }));
  if (!bars.length) throw new Error(`No intraday bars for ${ticker}`);

  // Unique NY days in order
  const daysNY = [];
  for (const b of bars) {
    const dstr = dayjs(b.date).tz(NY).format('YYYY-MM-DD');
    if (!daysNY.length || daysNY[daysNY.length-1] !== dstr) daysNY.push(dstr);
  }

  const dayRows = [];
  for (const dstr of daysNY) {
    const phases = pickPhasesForDayNY(bars, dayjs.tz(dstr, NY));
    if (!phases) continue;
    const rows = [];
    if (phases.AH) rows.push({ phase:'AH', t: phases.AH.date, close: phases.AH.close });
    if (phases.MO) rows.push({ phase:'MO', t: phases.MO.date, close: phases.MO.close });
    if (phases.MC) rows.push({ phase:'MC', t: phases.MC.date, close: phases.MC.close });
    if (phases.C)  rows.push({ phase:'C' , t: phases.C.date , close: phases.C.close  });
    dayRows.push({ date: dstr, rows });
  }

  return { candlesIntraday: bars, dayRows };
}

module.exports = { buildDayRowsFromYahoo };

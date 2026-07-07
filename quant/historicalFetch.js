// historicalFetch.js — extended (multi-year) history for the quant layer only.
//
// The EXISTING pipeline (server.js) fetches ~2 years of history for its own
// use and must not be touched (prime directive #1). B1's 5-year bootstrap
// window and S1's 2008/2020/2022 replay episodes both need history the
// existing 2-year fetch doesn't cover, so the quant layer fetches its own
// longer series here, additively, via the same historicalCompat() utility
// the rest of the backend already uses.
//
// Fetched once per symbol and cached for the same 15-day heartbeat as
// everything else in the quant layer (§6.3) — repeat checks within that
// window reuse the cached series instead of re-fetching ~18 years of daily
// candles every time.

const { historicalCompat } = require('../lib/yfCompat');

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const EXTENDED_START = '2007-06-01'; // comfortably before the 2008 GFC episode window

const cache = new Map(); // symbol -> { rows, logRet, fetchedAt }

function toLogReturns(rows) {
  const logRet = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close, cur = rows[i].close;
    if (prev > 0 && cur > 0) logRet.push({ date: rows[i].date, r: Math.log(cur / prev) });
  }
  return logRet;
}

/**
 * @param {string} symbol
 * @returns {Promise<{ rows: Array, logRet: Array<{date, r}> }>}
 */
async function getExtendedHistory(symbol) {
  const cached = cache.get(symbol);
  if (cached && (Date.now() - cached.fetchedAt) < FIFTEEN_DAYS_MS) return cached;

  const rows = await historicalCompat(symbol, {
    period1: EXTENDED_START,
    period2: new Date().toISOString().slice(0, 10),
    interval: '1d',
  }).catch(() => []);

  const entry = { rows, logRet: toLogReturns(rows), fetchedAt: Date.now() };
  cache.set(symbol, entry);
  return entry;
}

/** Plain numeric log-return array, trailing `windowDays` entries — for Model B. */
function trailingLogReturns(extended, windowDays) {
  const all = extended.logRet.map(x => x.r);
  return all.slice(-windowDays);
}

/**
 * Real historical return sequence for a specific [start, end] window — for
 * S1's historical replay. Returns null if the stock's history doesn't reach
 * back that far (e.g. a recent IPO), so the caller can mark that episode
 * "not applicable" instead of fabricating one.
 */
function episodeReturns(extended, start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const inWindow = extended.logRet.filter(x => {
    const t = x.date instanceof Date ? x.date.getTime() : new Date(x.date).getTime();
    return t >= startMs && t <= endMs;
  });
  if (!inWindow.length) return null;
  // Does the stock's history actually start before (or at) the episode, i.e.
  // was it trading through this period at all, not just coincidentally
  // overlapping a sparse tail?
  const earliestAvailable = extended.rows[0]?.date;
  if (earliestAvailable && new Date(earliestAvailable).getTime() > startMs + 5 * 24 * 3600 * 1000) return null;
  return inWindow.map(x => x.r);
}

module.exports = { getExtendedHistory, trailingLogReturns, episodeReturns };

// backend/lib/yfCompat.js
// A tiny compatibility wrapper that mimics yahooFinance.historical()
// using the newer chart() endpoint (since historical() is deprecated).

const yf = require('yahoo-finance2').default;

/**
 * historicalCompat(symbol, { period1, period2, interval })
 * - If period1 is a string like '30d'/'1mo'/'3mo'... it is treated as range.
 * - Otherwise period1/period2 can be Date/string timestamps.
 * - interval defaults to '1d'.
 */
async function historicalCompat(symbol, opts = {}) {
  const { period1, period2, interval = '1d' } = opts;
  const q = { interval };

  if (typeof period1 === 'string' && !period2) {
    // Range mode e.g. '30d' -> chart({ range: '1mo' })
    // Yahoo accepts '1mo','3mo','6mo','1y','2y','5y','10y','ytd','max'
    q.range = (period1 === '30d') ? '1mo' : period1; // map 30d -> 1mo
  } else {
    // Start / end mode
    if (period1) q.period1 = period1;
    if (period2) q.period2 = period2;
  }

  const res = await yf.chart(symbol, q);

  // chart() returns arrays; convert to "historical rows" objects
  const ts = res?.timestamp || [];
  const quote = res?.indicators?.quote?.[0] || {};
  const adj = res?.indicators?.adjclose?.[0]?.adjclose || [];

  const rows = ts.map((t, i) => ({
    date: new Date(t * 1000),
    open: quote.open?.[i],
    high: quote.high?.[i],
    low: quote.low?.[i],
    close: quote.close?.[i],
    adjClose: adj?.[i],
    volume: quote.volume?.[i],
  })).filter(r => Number.isFinite(r.close));

  return rows;
}

module.exports = { yf, historicalCompat };

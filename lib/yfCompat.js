// backend/lib/yfCompat.js
// Compatibility wrapper around yahoo-finance2 chart()
// with fetchOptions + light throttling + graceful fallback.

const https = require('https');
const yf = require('yahoo-finance2').default;

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 25,
});

const fetchOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json,text/plain,*/*',
  },
  redirect: 'follow',
  agent: keepAliveAgent,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    q.range = (period1 === '30d') ? '1mo' : period1;
  } else {
    if (period1) q.period1 = period1;
    if (period2) q.period2 = period2;
  }

  try {
    // light throttle to reduce Yahoo rate-limit hits
    await sleep(700);

    // yf.historical() returns a clean array of OHLCV objects directly
    const raw = await yf.historical(symbol, q, { fetchOptions, validateResult: false });

    return (raw || [])
      .map(r => ({
        date: r.date instanceof Date ? r.date : new Date(r.date),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        adjClose: r.adjClose,
        volume: r.volume,
      }))
      .filter(r => r.close != null && Number.isFinite(r.close));

  } catch (err) {
    console.error(`yahooHistorical ${symbol}:`, err.message);
    return [];
  }
}

module.exports = { yf, historicalCompat, fetchOptions };

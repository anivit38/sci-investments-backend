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

    const res = await yf.chart(symbol, q, { fetchOptions });

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
    })).filter(r => r.close != null && Number.isFinite(r.close));

    return rows;
  } catch (err) {
    console.error(`yahooHistorical ${symbol}:`, err.message);
    return [];
  }
}

module.exports = { yf, historicalCompat, fetchOptions };

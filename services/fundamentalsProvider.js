// services/fundamentalsProvider.js

const fmpRaw       = require("./fmpRawService");
const av           = require("./avService");
const yahooMetrics = require("./yahooMetrics");
// const iex         = require("./iexService"); // <-- uncomment once you add IEX
                            
// order is important: FMP → AlphaVantage → Yahoo → (IEX)
const providers = [
  fmpRaw,         // 1) raw FMP ratios & profile (with disk-cache/fallback on 429)
  av,             // 2) Alpha Vantage “OVERVIEW” (PE, P/B, DivYield, margins, ROA/ROE…)
  yahooMetrics    // 3) Yahoo Finance summaryDetail/defaultKeyStatistics
  // iex          // 4) IEX Cloud, once you build iexService.js
];

// in-memory cache so we don’t hammer upstream more than once per metric
const cache = {};

/**
 * Try each provider in order until one yields non-null,
 * then cache and return it.  If all return null, we cache+return null.
 *
 * This exact same logic applies whether or not you ever hit a 429 —
 * the only extra cost is a quick in-memory lookup.
 */
async function fetchWithFallback(symbol, metricKey) {
  // initialize per-symbol cache bucket
  if (!cache[symbol]) cache[symbol] = {};

  // if we’ve already asked for this symbol+metric, return it (even if null)
  if (cache[symbol].hasOwnProperty(metricKey)) {
    return cache[symbol][metricKey];
  }

  // otherwise, try each service in turn
  for (const svc of providers) {
    let val = null;
    try {
      val = await svc.getMetric(symbol, metricKey);
    } catch (err) {
      // swallow any provider-specific errors (timeouts, 429s, network, etc.)
    }
    if (val != null) {
      cache[symbol][metricKey] = val;
      return val;
    }
  }

  // nothing found — cache and return null
  cache[symbol][metricKey] = null;
  return null;
}

module.exports = { fetchWithFallback };

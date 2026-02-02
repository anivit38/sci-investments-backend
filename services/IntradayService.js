// backend/services/IntradayService.js

let yahooFinance;
try {
  // Prefer your compat wrapper (usually includes better defaults/headers)
  ({ yf: yahooFinance } = require("../lib/yfCompat"));
} catch {
  // Fallback to raw library
  yahooFinance = require("yahoo-finance2").default;
}

const ALLOWED_INTERVALS = ["1m", "2m", "5m", "15m", "30m", "60m"];
const ALLOWED_RANGES = ["1d", "5d", "1mo", "3mo"];

function clampToIntradayLimit(period1, period2, interval) {
  const maxDays = interval === "1m" ? 30 : 60;
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  if (period2 - period1 > maxMs) return new Date(period2.getTime() - maxMs + 60 * 1000);
  return period1;
}

exports.getIntradayIndicators = async (symbol, opts = {}) => {
  const now = new Date();
  let { interval = "1m", range = "1d", from, to } = opts;

  if (interval && !ALLOWED_INTERVALS.includes(interval)) {
    throw new Error(`Invalid interval. Allowed: ${ALLOWED_INTERVALS.join(", ")}`);
  }
  if (range && !ALLOWED_RANGES.includes(range)) {
    throw new Error(`Invalid range. Allowed: ${ALLOWED_RANGES.join(", ")}`);
  }

  let period1, period2;
  if (from || to) {
    period2 = to ? new Date(to) : now;
    period1 = from ? new Date(from) : new Date(period2.getTime() - 24 * 60 * 60 * 1000);
  } else {
    const rangeToDays = { "1d": 1, "5d": 5, "1mo": 30, "3mo": 90 };
    const days = rangeToDays[range] ?? 1;
    period2 = now;
    period1 = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }

  period1 = clampToIntradayLimit(period1, period2, interval);

  // If Yahoo blocks / fails, let caller decide how to degrade (server now returns [])
  const result = await yahooFinance.chart(symbol, {
    period1,
    period2,
    interval,
    includePrePost: false,
  });

  const quotes = result?.quotes ?? [];
  return quotes
    .filter(q =>
      q &&
      q.open != null &&
      q.high != null &&
      q.low != null &&
      q.close != null
    )
    .map(q => ({
      timestamp: +new Date(q.date),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume ?? null,
    }));
};

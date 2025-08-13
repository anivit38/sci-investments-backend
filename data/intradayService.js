// backend/data/intradayService.js

const yahoo = require("yahoo-finance2").default;

// ──────── Utility Functions ────────
function sma(arr, n, i) {
  if (i < n - 1) return null;
  let sum = 0;
  for (let j = i - n + 1; j <= i; j++) sum += arr[j];
  return sum / n;
}

function stdev(arr, n, i) {
  if (i < n - 1) return null;
  const m = sma(arr, n, i);
  let sum = 0;
  for (let j = i - n + 1; j <= i; j++) sum += (arr[j] - m) ** 2;
  return Math.sqrt(sum / n);
}

function ema(arr, period, i) {
  const k = 2 / (period + 1);
  if (i === 0) return arr[0];
  let val = arr[0];
  for (let j = 1; j <= i; j++) {
    val = arr[j] * k + val * (1 - k);
  }
  return val;
}

function computeRSI(closes, period = 14) {
  const rsi = Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? gains += d : losses += -d;
  }
  let avgG = gains / period, avgL = losses / period;
  rsi[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    rsi[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  const macd = Array(closes.length).fill(null);
  const sig  = Array(closes.length).fill(null);
  if (closes.length < slow) return { macd, signalLine: sig };
  const fastE = closes.map((_, i) => (i === 0 ? closes[0] : ema(closes, fast, i)));
  const slowE = closes.map((_, i) => (i === 0 ? closes[0] : ema(closes, slow, i)));
  for (let i = slow - 1; i < closes.length; i++) {
    macd[i] = fastE[i] - slowE[i];
  }
  let prev = macd[slow - 1];
  for (let i = slow; i < closes.length; i++) {
    if (macd[i] == null) continue;
    prev = macd[i] * (2/(signal+1)) + prev * (1 - 2/(signal+1));
    sig[i] = prev;
  }
  return { macd, signalLine: sig };
}

function computeVWAP(bars) {
  let cumTPV = 0, cumVol = 0;
  return bars.map(d => {
    const tp = (d.high + d.low + d.close) / 3;
    cumTPV += tp * d.volume;
    cumVol += d.volume;
    return cumVol ? cumTPV / cumVol : null;
  });
}

function computeBB(closes, period = 20, mult = 2) {
  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = sma(closes, period, i), s = stdev(closes, period, i);
    upper[i] = m + mult * s;
    lower[i] = m - mult * s;
  }
  return { upper, lower };
}

// backend/data/intradayService.js

const fetch = require("node-fetch");

// ──────── Utility Functions ────────
// (copy over your sma, stdev, ema, computeRSI, computeMACD, computeVWAP, computeBB)

async function getIntradayIndicators(symbol) {
  // 1) Fetch the raw JSON from Yahoo’s REST endpoint
  let json;
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=5m&includePrePost=false`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    json = await res.json();
  } catch (err) {
    console.error(`❌ HTTP fetch failed for ${symbol}:`, err.message);
    throw new Error("Failed to fetch intraday data: " + err.message);
  }

  // 2) Drill into the result
  const result = json.chart?.result?.[0];
  if (!result) {
    console.error("❌ No chart data in JSON:", JSON.stringify(json, null, 2));
    throw new Error("No chart data returned");
  }

  // 3) Extract timestamps + quotes
  const ts    = result.timestamp || [];
  const quote = result.indicators.quote?.[0] || {};
  const opens = quote.open   || [];
  const highs = quote.high   || [];
  const lows  = quote.low    || [];
  const closes= quote.close  || [];
  const vols  = quote.volume || [];

  // 4) Assemble & filter bars
  const bars = ts.map((t, i) => {
    if ([opens, highs, lows, closes, vols].some(arr => arr[i] == null)) return null;
    return {
      date:   new Date(t * 1000),
      open:   opens[i],
      high:   highs[i],
      low:    lows[i],
      close:  closes[i],
      volume: vols[i],
    };
  }).filter(Boolean);

  if (!bars.length) throw new Error("No valid intraday bars");

  // 5) Take last 50 bars and compute your indicators
  const slice = bars.slice(-50);
  const C     = slice.map(d => d.close);

  const ema5     = C.map((_,i)=>ema(C,5,i));
  const ema10    = C.map((_,i)=>ema(C,10,i));
  const rsi14    = computeRSI(C,14);
  const { macd, signalLine } = computeMACD(C,12,26,9);
  const vwap     = computeVWAP(slice);
  const { upper, lower }     = computeBB(C,20,2);

  // 6) Return in the same shape as before
  return {
    symbol,
    series: slice.map((d,i) => ({
      timestamp: d.date,
      open:   d.open,
      high:   d.high,
      low:    d.low,
      close:  d.close,
      volume: d.volume,
      ema5:   +ema5[i].toFixed(4),
      ema10:  +ema10[i].toFixed(4),
      rsi14:  rsi14[i] != null     ? +rsi14[i].toFixed(2)     : null,
      macd:   macd[i]    != null   ? +macd[i].toFixed(4)      : null,
      signal: signalLine[i] != null? +signalLine[i].toFixed(4): null,
      vwap:   vwap[i]    != null   ? +vwap[i].toFixed(4)      : null,
      bbUpper: upper[i]  != null   ? +upper[i].toFixed(4)     : null,
      bbLower: lower[i]  != null   ? +lower[i].toFixed(4)     : null,
    })),
    latestIndicators: {
      ema5:    +ema5.slice(-1)[0].toFixed(4),
      ema10:   +ema10.slice(-1)[0].toFixed(4),
      rsi14:   rsi14.slice(-1)[0]      != null ? +rsi14.slice(-1)[0].toFixed(2)      : null,
      macd:    macd.slice(-1)[0]       != null ? +macd.slice(-1)[0].toFixed(4)       : null,
      signal:  signalLine.slice(-1)[0] != null ? +signalLine.slice(-1)[0].toFixed(4) : null,
      vwap:    vwap.slice(-1)[0]       != null ? +vwap.slice(-1)[0].toFixed(4)       : null,
      bbUpper: upper.slice(-1)[0]      != null ? +upper.slice(-1)[0].toFixed(4)      : null,
      bbLower: lower.slice(-1)[0]      != null ? +lower.slice(-1)[0].toFixed(4)      : null,
    }
  };
}

module.exports = { getIntradayIndicators };

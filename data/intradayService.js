// backend/data/intradayService.js

const yahoo = require("yahoo-finance2").default;

// ──────── Utility Functions ────────
function sma(arr, period, idx) {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let i = idx - (period - 1); i <= idx; i++) {
    sum += arr[i];
  }
  return sum / period;
}

function stdev(arr, period, idx) {
  if (idx < period - 1) return null;
  const mean = sma(arr, period, idx);
  let sumSq = 0;
  for (let i = idx - (period - 1); i <= idx; i++) {
    sumSq += (arr[i] - mean) ** 2;
  }
  return Math.sqrt(sumSq / period);
}

function ema(arr, period, idx) {
  const k = 2 / (period + 1);
  if (idx === 0) return arr[0];
  let prevEma = arr[0];
  for (let i = 1; i <= idx; i++) {
    prevEma = arr[i] * k + prevEma * (1 - k);
  }
  return prevEma;
}

function computeRSI(closes, period = 14) {
  const rsi = Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const macdLine = Array(closes.length).fill(null);
  const signalLine = Array(closes.length).fill(null);
  const histogram = Array(closes.length).fill(null);

  if (closes.length < slowPeriod) return { macdLine, signalLine, histogram };

  const fastEMA = closes.map((_, i) => (i === 0 ? closes[0] : ema(closes, fastPeriod, i)));
  const slowEMA = closes.map((_, i) => (i === 0 ? closes[0] : ema(closes, slowPeriod, i)));

  for (let i = 0; i < closes.length; i++) {
    if (i < slowPeriod - 1) continue;
    macdLine[i] = fastEMA[i] - slowEMA[i];
  }

  let signalIdx = slowPeriod - 1;
  let prevSignalEMA = macdLine[signalIdx];
  for (let i = signalIdx + 1; i < closes.length; i++) {
    if (macdLine[i] === null) continue;
    prevSignalEMA = macdLine[i] * (2 / (signalPeriod + 1)) + prevSignalEMA * (1 - 2 / (signalPeriod + 1));
    signalLine[i] = prevSignalEMA;
  }
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && signalLine[i] !== null) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  return { macdLine, signalLine, histogram };
}

function computeVWAP(bars) {
  const cumTPV = [];
  const cumVol = [];
  let runningTPV = 0;
  let runningVol = 0;

  bars.forEach((d, i) => {
    const tp = (d.high + d.low + d.close) / 3;
    runningTPV += tp * d.volume;
    runningVol += d.volume;
    cumTPV[i] = runningTPV;
    cumVol[i] = runningVol;
  });
  return bars.map((_, i) => (cumVol[i] === 0 ? null : cumTPV[i] / cumVol[i]));
}

function computeBollingerBands(closes, period = 20, stdDevMult = 2) {
  const upper = Array(closes.length).fill(null);
  const lower = Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) continue;
    const m = sma(closes, period, i);
    const s = stdev(closes, period, i);
    upper[i] = m + stdDevMult * s;
    lower[i] = m - stdDevMult * s;
  }
  return { upper, lower };
}

// ──────── Core Function ────────
async function getIntradayIndicators(symbol) {
  let raw;
  try {
    const queryOptions = { interval: "5m", range: "7d" };
    raw = await yahoo.historical(symbol, queryOptions);
  } catch (e) {
    console.error(`❌ Error fetching intraday data for ${symbol}:`, e.message);
    throw new Error("Failed to fetch intraday data");
  }

  if (!raw || raw.length === 0) {
    throw new Error("No intraday data returned");
  }

  const lastN = 50;
  const bars = raw.slice(-lastN);

  const closes = bars.map((d) => d.close);
  const highs = bars.map((d) => d.high);
  const lows = bars.map((d) => d.low);
  const volumes = bars.map((d) => d.volume);

  const ema5 = closes.map((_, i) => (i === 0 ? closes[0] : ema(closes, 5, i)));
  const ema10 = closes.map((_, i) => (i === 0 ? closes[0] : ema(closes, 10, i)));

  const rsi14 = computeRSI(closes, 14);

  const { macdLine, signalLine } = computeMACD(closes, 12, 26, 9);

  const vwap = computeVWAP(bars);

  const { upper: bbUpper, lower: bbLower } = computeBollingerBands(closes, 20, 2);

  return {
    symbol,
    series: bars.map((d, i) => ({
      timestamp: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
      ema5: +ema5[i].toFixed(4),
      ema10: +ema10[i].toFixed(4),
      rsi14: rsi14[i] !== null ? +rsi14[i].toFixed(2) : null,
      macd: macdLine[i] !== null ? +macdLine[i].toFixed(4) : null,
      signal: signalLine[i] !== null ? +signalLine[i].toFixed(4) : null,
      vwap: vwap[i] !== null ? +vwap[i].toFixed(4) : null,
      bbUpper: bbUpper[i] !== null ? +bbUpper[i].toFixed(4) : null,
      bbLower: bbLower[i] !== null ? +bbLower[i].toFixed(4) : null,
    })),
    latestIndicators: {
      ema5: +ema5[bars.length - 1].toFixed(4),
      ema10: +ema10[bars.length - 1].toFixed(4),
      rsi14: rsi14[bars.length - 1] !== null ? +rsi14[bars.length - 1].toFixed(2) : null,
      macd: macdLine[bars.length - 1] !== null ? +macdLine[bars.length - 1].toFixed(4) : null,
      signal: signalLine[bars.length - 1] !== null ? +signalLine[bars.length - 1].toFixed(4) : null,
      vwap: vwap[bars.length - 1] !== null ? +vwap[bars.length - 1].toFixed(4) : null,
      bbUpper: bbUpper[bars.length - 1] !== null ? +bbUpper[bars.length - 1].toFixed(4) : null,
      bbLower: bbLower[bars.length - 1] !== null ? +bbLower[bars.length - 1].toFixed(4) : null,
    },
  };
}

module.exports = { getIntradayIndicators };

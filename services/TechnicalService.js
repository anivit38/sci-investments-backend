// services/TechnicalService.js
// Keeps your existing behavior + adds safety guards so prices never equal,
// and exposes indicators/trend/levels/suggestion for /api/check-stock.

const { yf: yahooFinance, historicalCompat } = require('../lib/yfCompat');
const { sizePositionFromProfile } = require('./PositionSizingService');
const UserProfile = require('../models/UserProfile');

const {
  SMA, EMA, RSI, MACD,
  ADX, ATR, BollingerBands
} = require('technicalindicators');
const QuickChart = require('quickchart-js');

// ── helpers ──────────────────────────────────────────────────────────────────
function nextTradingDay(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  const wd = d.getDay();
  if (wd === 6) d.setDate(d.getDate() + 2);
  if (wd === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// round to sensible tick based on price level
function roundToTick(n, price) {
  if (price < 2) return +n.toFixed(4);
  if (price < 10) return +n.toFixed(3);
  return +n.toFixed(2);
}

// ensure entry/stop/target are separated by a minimum move
function enforceDistancesLong(entry, stop, target) {
  const price = entry;
  const minMove = Math.max(entry * 0.0025, 0.02); // ≥0.25% or $0.02
  if (!(stop < entry)) stop = roundToTick(entry - minMove, price);
  if (!(target > entry)) target = roundToTick(entry + minMove, price);
  if (target - entry < minMove) target = roundToTick(entry + minMove, price);
  if (entry - stop < minMove)   stop   = roundToTick(entry - minMove,  price);
  return { stop, target };
}

async function getTechnical(symbol, opts = {}) {
  // 0) Live quote
  let quote = null;
  try { quote = await yahooFinance.quote(symbol); } catch (_) {}


  // 1) Session state
  const rawTime = quote?.regularMarketTime;
  const nowMs   = rawTime ? (rawTime > 1e12 ? rawTime : rawTime * 1000) : Date.now();
  const now     = new Date(nowMs);
  const todayISO = now.toISOString().slice(0, 10);
  const openUTC  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 30);
  const closeUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0);
  const inSession = nowMs >= openUTC && nowMs <= closeUTC && quote?.regularMarketPrice > 0;
  const livePrice = inSession ? quote.regularMarketPrice : null;

  // 2) Range: one year
  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const period1 = yearAgo.toISOString().slice(0, 10);
  const period2 = todayISO;

  // 3) History
  let history = [];
  try {
    history = await historicalCompat(symbol, { period1, period2, interval: '1d' });
  } catch {
    history = [];
  }


  // 4) Fallback if nothing
  let isFallback = false;
  if (!history.length) {
    const fb = quote?.regularMarketPreviousClose || quote?.regularMarketPrice;
    if (!fb) {
      return { symbol, technical: [], instructions: ['No price history available or failed to fetch.'], chartUrl: '' };
    }
    history = [{ date: todayISO, open: fb, high: fb, low: fb, close: fb, volume: 0 }];
    isFallback = true;
  }

  // 5) Normalize arrays
  const dates   = history.map(r => (typeof r.date === 'string') ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10));
  const opens   = history.map(r => r.open);
  const highs   = history.map(r => r.high);
  const lows    = history.map(r => r.low);
  const closes  = history.map(r => r.close);
  const volumes = history.map(r => r.volume || 0);

  if (isFallback) {
    const c = closes[0];
    const lvlPad = Math.max(c * 0.005, 0.05); // ~0.5% or $0.05
    return {
      symbol,
      technical: history,
      indicators: {
        RSI14: null,
        MACD: null,
        SMA50: null,
        SMA200: null,
        ATR14: null,
        BB_upper: null,
        BB_lower: null,
      },
      trend: 'sideways',
      levels: { support: +(c - lvlPad).toFixed(2), resistance: +(c + lvlPad).toFixed(2) },
      suggestion: { action: 'hold', rationale: ['Insufficient history to compute indicators.'] },
      instructions: [
        `Last available price on ${dates[0]} was $${c.toFixed(2)} — not enough data to compute signals.`,
      ],
      chartUrl: '',
    };
  }


  // 6) Indicators (full series)
  const sma20    = SMA.calculate({ period: 20,  values: closes });
  const sma50    = SMA.calculate({ period: 50,  values: closes });
  const sma200   = SMA.calculate({ period: 200, values: closes });
  const ema50    = EMA.calculate({ period: 50,  values: closes });
  const rsi14    = RSI.calculate({ period: 14,  values: closes });
  const macdArr  = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const adx14    = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const atr14    = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
  const bb       = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
  const volMA10  = volumes.length >= 10 ? SMA.calculate({ period: 10, values: volumes }) : [];

  // 7) Zip rows where all core indicators exist
  const raw = dates.map((d, i) => ({
    date:    d,
    open:    opens[i],  high: highs[i],   low: lows[i],    close: closes[i],
    volume:  volumes[i],
    sma20:   i >= 19  ? sma20[i - 19]           : null,
    sma50:   i >= 49  ? sma50[i - 49]           : null,
    sma200:  i >= 199 ? sma200[i - 199]         : null,
    ema50:   i >= 49  ? ema50[i - 49]           : null,
    rsi14:   i >= 13  ? rsi14[i - 13]           : null,
    macd:    i >= 26  ? macdArr[i - 26]         : null,
    adx14:   i >= 13  ? adx14[i - 13]?.adx      : null,
    atr14:   i >= 13  ? atr14[i - 13]           : null,
    bbLower: i >= 19  ? bb[i - 19]?.lower       : null,
    bbUpper: i >= 19  ? bb[i - 19]?.upper       : null,
    volMA10: i >= 9   ? volMA10[i - 9]          : null,
  })).filter(r => r.sma20 !== null && r.ema50 !== null && r.rsi14 !== null);

  if (!raw.length) {
    const lastClose = closes[closes.length - 1];
    const lvlPad = Math.max(lastClose * 0.005, 0.05);
    return {
      symbol,
      technical: [],
      indicators: {
        RSI14: null,
        MACD: null,
        SMA50: null,
        SMA200: null,
        ATR14: null,
        BB_upper: null,
        BB_lower: null,
      },
      trend: 'sideways',
      levels: { support: +(lastClose - lvlPad).toFixed(2), resistance: +(lastClose + lvlPad).toFixed(2) },
      suggestion: { action: 'hold', rationale: ['No valid bars after indicator calc.'] },
      instructions: ['No valid price bars remain after indicator calculation — cannot generate signals.'],
      chartUrl: '',
    };
  }


  // 8) Focus on last two bars
  const prev = raw[raw.length - 2];
  const curr = raw[raw.length - 1];
  const priceNow = inSession ? (livePrice ?? curr.close) : curr.close;

  // ATR safety floor to avoid zero-distance targets
  const atrFloor = Math.max((priceNow || 1) * 0.005, 0.05); // ≥0.5% or $0.05
  const useATR   = (curr.atr14 && Number.isFinite(curr.atr14)) ? Math.max(curr.atr14, atrFloor) : atrFloor;

  const strongTrend = (curr.adx14 || 0) > 25;

  let buySignal  = null;
  let sellSignal = null;

  // ── BUY #1: MA cross up + rising RSI + near/below lower band + strong ADX ──
  if (
    prev.close <= prev.sma20 &&
    prev.close <= (prev.ema50 ?? prev.sma50 ?? prev.sma20) &&
    curr.close >  curr.sma20 &&
    curr.close >  (curr.ema50 ?? curr.sma50 ?? curr.sma20) &&
    curr.rsi14 > prev.rsi14 &&
    (curr.bbLower ? curr.close <= curr.bbLower * 1.01 : true) &&
    strongTrend
  ) {
    const entry  = roundToTick(priceNow, priceNow);
    let stop     = roundToTick(entry - 1.2 * useATR, priceNow);
    let target   = roundToTick(entry + 2.5 * useATR, priceNow);
    ({ stop, target } = enforceDistancesLong(entry, stop, target));
    buySignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    entry,
      stop,
      target,
      reason:   'MA crossover + rising RSI + BB lower touch + strong ADX'
    };
  }

  // ── BUY #2: MACD line crossover ──
  if (!buySignal && prev.macd && curr.macd &&
      prev.macd.MACD < prev.macd.signal &&
      curr.macd.MACD > curr.macd.signal) {
    const entry  = roundToTick(priceNow, priceNow);
    let stop     = roundToTick(entry - 1.1 * useATR, priceNow);
    let target   = roundToTick(entry + 2.0 * useATR, priceNow);
    ({ stop, target } = enforceDistancesLong(entry, stop, target));
    buySignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    entry,
      stop,
      target,
      reason:   'MACD line crossover'
    };
  }

  // ── BUY #3: 20-day breakout + volume spike ──
  const prior20High = Math.max(...raw.slice(-21, -1).map(r => r.high));
  if (!buySignal &&
      curr.close > prior20High &&
      curr.volume > (curr.volMA10 * 1.5)) {
    const entry  = roundToTick(priceNow, priceNow);
    let stop     = roundToTick(Math.min(entry - (0.5 * useATR), prior20High * 0.99), priceNow);
    let target   = roundToTick(entry * 1.04, priceNow);
    ({ stop, target } = enforceDistancesLong(entry, stop, target));
    buySignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    entry,
      stop,
      target,
      reason:   'Breakout above 20-day high + volume spike'
    };
  }

  // ── SELL/EXIT conditions ──
  if (
    (curr.bbUpper && curr.close >= curr.bbUpper) ||
    (curr.rsi14   && curr.rsi14 > 70) ||
    (prev.macd && curr.macd && curr.macd.histogram < prev.macd.histogram)
  ) {
    let why;
    if (curr.bbUpper && curr.close >= curr.bbUpper) why = 'Touched BB upper';
    else if (curr.rsi14 && curr.rsi14 > 70)         why = 'RSI14 > 70';
    else                                           why = 'MACD histogram reversal';
    sellSignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    roundToTick(priceNow, priceNow),
      reason:   why
    };
  }

  // SELL #2: MACD line cross-down
  if (!sellSignal && prev.macd && curr.macd &&
      prev.macd.MACD > prev.macd.signal &&
      curr.macd.MACD < curr.macd.signal) {
    sellSignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    roundToTick(priceNow, priceNow),
      reason:   'MACD line cross-down'
    };
  }

  // SELL #3: 20-day breakdown + volume spike
  const prior20Low = Math.min(...raw.slice(-21, -1).map(r => r.low));
  if (!sellSignal &&
      curr.close < prior20Low &&
      curr.volume > (curr.volMA10 * 1.5)) {
    sellSignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    roundToTick(priceNow, priceNow),
      reason:   'Breakdown below 20-day low + volume spike'
    };
  }

  // Avoid equal/negative edge: if we have both, make sure exit > entry by a min move
  if (buySignal && sellSignal) {
    const minExit = Math.max(atrFloor, buySignal.price * 0.0025, 0.02);
    if (sellSignal.price <= buySignal.price || (sellSignal.price - buySignal.price) < minExit) {
      // Prefer buy target if it’s far enough; otherwise push to minExit
      const adjusted = Math.max(buySignal.target, buySignal.price + minExit);
      sellSignal.price  = roundToTick(adjusted, buySignal.price);
      sellSignal.reason = 'Exit at adjusted target (avoid zero/negative edge)';
    }
  }


    // 10.5) Optional position sizing from user profile
  if (buySignal && opts.profile) {
   try {
     const sizing = sizePositionFromProfile({
       profile: opts.profile,
       signal: { price: buySignal.price, stop: buySignal.stop },
       atr: useATR,
      });
     buySignal.qty = sizing.qty || 0;        // expose simple qty
     buySignal.sizing = sizing;              // keep full details for the UI/logs
   } catch (_) {
     // ignore sizing errors; instructions will still render
   }
 }


  // 11) Human instructions (kept as before)
  // 11) Build human instructions (with optional size)
  const instructions = [];
  const qtyText = buySignal?.qty ? `, size: ${buySignal.qty} shares` : '';

  if (buySignal && !sellSignal) {
    instructions.push(
      `On ${buySignal.date}: **BUY** at \$${buySignal.price}${qtyText} ` +
      `(reason: ${buySignal.reason}), stop-loss at \$${buySignal.stop}, ` +
      `target at \$${buySignal.target}.`
    );
  } else if (!buySignal && sellSignal) {
    instructions.push(
      `On ${sellSignal.date}: **SELL** at \$${sellSignal.price} ` +
      `(reason: ${sellSignal.reason}).`
    );
  } else if (buySignal && sellSignal) {
    instructions.push(
      `On ${buySignal.date}: **BUY** at \$${buySignal.price}${qtyText} (reason: ${buySignal.reason}).`,
      `Then on ${sellSignal.date}: **SELL** at \$${sellSignal.price} (reason: ${sellSignal.reason}).`
    );
  } else {
    instructions.push(
      'No clear buy or sell trigger on the most recent bar—hold or wait.'
    );
  }



  // 12) Chart (unchanged)
  const chart = new QuickChart()
    .setConfig({
      type: 'line',
      data: {
        labels: raw.map(r => r.date),
        datasets: [
          { label: 'Close',    data: raw.map(r => r.close),   fill: false },
          { label: 'SMA20',    data: raw.map(r => r.sma20),   fill: false },
          { label: 'EMA50',    data: raw.map(r => r.ema50),   fill: false },
          { label: 'BB Upper', data: raw.map(r => r.bbUpper), fill: false, borderDash: [5, 5] },
          { label: 'BB Lower', data: raw.map(r => r.bbLower), fill: false, borderDash: [5, 5] },
        ]
      },
      options: {
        title: { display: true, text: `${symbol} Price & Indicators` },
        scales: { xAxes: [{ type: 'time', time: { unit: 'day' } }] }
      }
    })
    .setWidth(800)
    .setHeight(400);

  // 13) Extra fields for /api/check-stock (without breaking old consumers)
  const trend = (curr.sma50 && curr.sma200)
    ? (curr.sma50 > curr.sma200 * 1.002 ? 'uptrend'
       : (curr.sma50 < curr.sma200 * 0.998 ? 'downtrend' : 'sideways'))
    : 'sideways';

  const indicators = {
    RSI14:  curr.rsi14 != null ? +curr.rsi14.toFixed(2) : null,
    MACD:   curr.macd ? {
      macd:    +curr.macd.MACD.toFixed(4),
      signal:  +curr.macd.signal.toFixed(4),
      hist:    +curr.macd.histogram.toFixed(4),
    } : null,
    SMA50:  curr.sma50 != null ? +curr.sma50.toFixed(2) : null,
    SMA200: curr.sma200 != null ? +curr.sma200.toFixed(2) : null,
    ATR14:  useATR != null ? +useATR.toFixed(4) : null,
    BB_upper: curr.bbUpper != null ? +curr.bbUpper.toFixed(2) : null,
    BB_lower: curr.bbLower != null ? +curr.bbLower.toFixed(2) : null,
  };

  const levels = {
    support: +Math.min(...raw.slice(-20).map(r => r.low)).toFixed(2),
    resistance: +Math.max(...raw.slice(-20).map(r => r.high)).toFixed(2),
  };

  const suggestion = buySignal
    ? { action: 'buy', entry: buySignal.price, stop: buySignal.stop, target: buySignal.target, rationale: [buySignal.reason, 'Stops/targets distance enforced.'] }
    : sellSignal
      ? { action: 'sell', exit: sellSignal.price, rationale: [sellSignal.reason] }
      : { action: 'hold', rationale: ['No clear trend/trigger.'] };

  // return shape stays backward-compatible
  return {
    symbol,
    technical: raw,          // <— same key you already return
    instructions,
    chartUrl: chart.getUrl(),
    // new, optional fields used by /api/check-stock:
    indicators,
    trend,
    levels,
    suggestion,
  };
}


async function getTechnicalForUser(symbol, userId) {
  let profile = null;
  try {
    if (userId) {
      profile = await UserProfile.findOne({ userId }).lean();
    }
  } catch (_) {
    // ignore; we'll just fall back to generic
  }
  // use profile if found; otherwise generic behavior
  return getTechnical(symbol, profile ? { profile } : {});
}


module.exports = { getTechnical, getTechnicalForUser };
// ──────────────────────────────────────────────────────────────────────────────

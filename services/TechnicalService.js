// services/TechnicalService.js
const yahoo      = require('yahoo-finance2').default;
const {
  SMA, EMA, RSI, MACD,
  ADX, ATR, BollingerBands
} = require('technicalindicators');
const QuickChart = require('quickchart-js');

// ─── helper to compute next trading-day (skipping weekends) ───
function nextTradingDay(date) {
  const d  = new Date(date);
  d.setDate(d.getDate() + 1);
  const wd = d.getDay();
  if (wd === 6) d.setDate(d.getDate() + 2);
  if (wd === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0,10);
}

async function getTechnical(symbol) {
  // 0) Fetch live quote
  let quote = null;
  try { quote = await yahoo.quote(symbol); }
  catch (_) { /* ignore */ }

  // 1) Determine “now” and market‐session state
  const rawTime = quote?.regularMarketTime;
  const nowMs   = rawTime
    ? (rawTime > 1e12 ? rawTime : rawTime * 1000)
    : Date.now();
  const now       = new Date(nowMs);
  const todayISO  = now.toISOString().slice(0,10);
  const openUTC   = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13,30);
  const closeUTC  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20,0);
  const inSession = nowMs >= openUTC && nowMs <= closeUTC && quote?.regularMarketPrice > 0;
  const livePrice = inSession ? quote.regularMarketPrice : null;

  // 2) Build one-year-ago → today range
  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const period1 = yearAgo.toISOString().slice(0,10);
  const period2 = todayISO;

  // 3) Fetch daily history
  let history = [];
  try {
    history = await yahoo.historical(symbol, { period1, period2, interval:'1d' });
  } catch {
    try {
      history = await yahoo.historical(symbol, { period1, period2 });
    } catch {
      history = [];
    }
  }

  // 4) If no history, fallback to single-bar
  let isFallback = false;
  if (!history.length) {
    const fb = quote?.regularMarketPreviousClose || quote?.regularMarketPrice;
    if (!fb) {
      return {
        symbol,
        technical: [],
        instructions: ['No price history available or failed to fetch.'],
        chartUrl: ''
      };
    }
    history = [{ date: todayISO, open:fb, high:fb, low:fb, close:fb, volume: 0 }];
    isFallback = true;
  }

  // 5) Normalize dates & collect arrays
  const dates   = history.map(r =>
    (typeof r.date === 'string')
      ? r.date.slice(0,10)
      : new Date(r.date).toISOString().slice(0,10)
  );
  const opens   = history.map(r=>r.open);
  const highs   = history.map(r=>r.high);
  const lows    = history.map(r=>r.low);
  const closes  = history.map(r=>r.close);
  const volumes = history.map(r=>r.volume || 0);

  // 6) If fallback, return that single bar + no-signal
  if (isFallback) {
    return {
      symbol,
      technical: history,
      instructions: [
        `Last available price on ${dates[0]} was \$${closes[0].toFixed(2)}—no signals generated.`
      ],
      chartUrl: ''
    };
  }

  // 7) Compute all indicators over the full year
  const sma20    = SMA.calculate({ period:20, values:closes });
  const ema50    = EMA.calculate({ period:50, values:closes });
  const rsi14    = RSI.calculate({ period:14, values:closes });
  const macdArr  = MACD.calculate({ values:closes, fastPeriod:12, slowPeriod:26, signalPeriod:9 });
  const adx14    = ADX.calculate({ period:14, high:highs, low:lows, close:closes });
  const atr14    = ATR.calculate({ period:14, high:highs, low:lows, close:closes });
  const bb       = BollingerBands.calculate({ period:20, stdDev:2, values:closes });
  // ─── NEW: 10-day volume MA ───
  const volMA10  = volumes.length >= 10
    ? SMA.calculate({ period:10, values:volumes })
    : [];

  // 8) Zip & filter to only bars with full indicators
  const raw = dates.map((d,i)=>({
    date:    d,
    open:    opens[i],  high: highs[i],   low: lows[i],    close: closes[i],
    volume:  volumes[i],
    sma20:   i>=19 ? sma20[i-19]           : null,
    ema50:   i>=49 ? ema50[i-50]           : null,
    rsi14:   i>=13 ? rsi14[i-14]           : null,
    macd:    i>=26 ? macdArr[i-26]         : null,
    adx14:   i>=13 ? adx14[i-14]?.adx      : null,
    atr14:   i>=13 ? atr14[i-14]           : null,
    bbLower: i>=19 ? bb[i-19]?.lower       : null,
    bbUpper: i>=19 ? bb[i-19]?.upper       : null,
    volMA10: i>=9  ? volMA10[i-9]          : null
  })).filter(r=>r.sma20!==null && r.ema50!==null && r.rsi14!==null);

  if (!raw.length) {
    return {
      symbol,
      technical: [],
      instructions: ['No valid price bars remain after indicator calculation—cannot generate signals.'],
      chartUrl: ''
    };
  }

  // 9) Only look at “yesterday” vs “today”
  const prev = raw[ raw.length - 2 ];
  const curr = raw[ raw.length - 1 ];
  const strongTrend = curr.adx14 > 25;

  let buySignal  = null;
  let sellSignal = null;

  // ── EXISTING BUY condition ──
  if (
    prev.close <= prev.sma20 &&
    prev.close <= prev.ema50 &&
    curr.close >  curr.sma20 &&
    curr.close >  curr.ema50 &&
    curr.rsi14 > prev.rsi14 &&
    curr.close <= curr.bbLower * 1.01 &&
    strongTrend
  ) {
    buySignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    +( inSession ? livePrice : curr.close ).toFixed(2),
      stop:     +( (inSession ? livePrice : curr.close) - (curr.atr14 * 1.2) ).toFixed(2),
      target:   +((inSession ? livePrice : curr.close) + (curr.atr14 * 2.5)).toFixed(2),
      reason:   'MA crossover + rising RSI + BB lower touch + strong ADX'
    };
  }

  // ── NEW BUY: MACD line crossover ──
  if (!buySignal &&
      prev.macd && curr.macd &&
      prev.macd.MACD < prev.macd.signal &&
      curr.macd.MACD > curr.macd.signal
  ) {
    buySignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    +( inSession ? livePrice : curr.close ).toFixed(2),
      stop:     +( (inSession ? livePrice : curr.close) - (curr.atr14 * 1.1) ).toFixed(2),
      target:   +((inSession ? livePrice : curr.close) + (curr.atr14 * 2.0)).toFixed(2),
      reason:   'MACD line crossover'
    };
  }

  // ── NEW BUY: 20-day breakout + volume spike ──
  const prior20High = Math.max(...raw.slice(-21, -1).map(r=>r.high));
  if (!buySignal &&
      curr.close > prior20High &&
      curr.volume > (curr.volMA10 * 1.5)
  ) {
    buySignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    +( inSession ? livePrice : curr.close ).toFixed(2),
      stop:     +( prior20High * 0.99 ).toFixed(2),
      target:   +(( inSession ? livePrice : curr.close ) * 1.04).toFixed(2),
      reason:   'Breakout above 20-day high + volume spike'
    };
  }

  // ── EXISTING SELL condition ──
  if (
    curr.close >= curr.bbUpper ||
    curr.rsi14 > 70 ||
    (prev.macd && curr.macd && curr.macd.histogram < prev.macd.histogram)
  ) {
    let why;
    if (curr.close >= curr.bbUpper)      why = 'Touched BB upper';
    else if (curr.rsi14 > 70)            why = 'RSI14 > 70';
    else                                 why = 'MACD histogram reversal';

    sellSignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    +( inSession ? livePrice : curr.close ).toFixed(2),
      reason:   why
    };
  }

  // ── NEW SELL: MACD line cross-down ──
  if (!sellSignal &&
      prev.macd && curr.macd &&
      prev.macd.MACD > prev.macd.signal &&
      curr.macd.MACD < curr.macd.signal
  ) {
    sellSignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    +( inSession ? livePrice : curr.close ).toFixed(2),
      reason:   'MACD line cross-down'
    };
  }

  // ── NEW SELL: 20-day breakdown + volume spike ──
  const prior20Low = Math.min(...raw.slice(-21, -1).map(r=>r.low));
  if (!sellSignal &&
      curr.close < prior20Low &&
      curr.volume > (curr.volMA10 * 1.5)
  ) {
    sellSignal = {
      dateOrig: curr.date,
      date:     nextTradingDay(now),
      price:    +( inSession ? livePrice : curr.close ).toFixed(2),
      reason:   'Breakdown below 20-day low + volume spike'
    };
  }

  // ── avoid locking in a loss ──
  if (buySignal && sellSignal && sellSignal.price < buySignal.price) {
    sellSignal.price  = buySignal.target;
    sellSignal.reason = 'Exit at ATR-based target (avoid locking in a loss)';
  }

  // 11) Build human instructions
  const instructions = [];
  if (buySignal && !sellSignal) {
    instructions.push(
      `On ${buySignal.date}: **BUY** at \$${buySignal.price} ` +
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
      `On ${buySignal.date}: **BUY** at \$${buySignal.price} (reason: ${buySignal.reason}).`,
      `Then on ${sellSignal.date}: **SELL** at \$${sellSignal.price} (reason: ${sellSignal.reason}).`
    );
  } else {
    instructions.push(
      'No clear buy or sell trigger on the most recent bar—hold or wait.'
    );
  }

  // 12) Build chart (unchanged)
  const chart = new QuickChart()
    .setConfig({
      type:'line',
      data:{
        labels: raw.map(r=>r.date),
        datasets:[
          { label:'Close',    data: raw.map(r=>r.close),  fill:false },
          { label:'SMA20',    data: raw.map(r=>r.sma20),  fill:false },
          { label:'EMA50',    data: raw.map(r=>r.ema50),  fill:false },
          { label:'BB Upper', data: raw.map(r=>r.bbUpper), fill:false, borderDash:[5,5] },
          { label:'BB Lower', data: raw.map(r=>r.bbLower), fill:false, borderDash:[5,5] }
        ]
      },
      options:{
        title:{ display:true, text:`${symbol} Price & Indicators` },
        scales:{ xAxes:[{ type:'time', time:{ unit:'day' } }] }
      }
    })
    .setWidth(800).setHeight(400);

  return {
    symbol,
    technical: raw,
    instructions,
    chartUrl: chart.getUrl()
  };
}

module.exports = { getTechnical };
// ──────────────────────────────────────────────────────────────────────────────
// services/TechnicalService.js
const yahoo      = require('yahoo-finance2').default;
const { SMA, EMA, RSI, MACD } = require('technicalindicators');
const QuickChart = require('quickchart-js');

// Use your existing CSV cache loader
const { getCachedHistoricalData } = require('../fetchData');

async function getTechnical(symbol) {
  // 1) Fetch history from Yahoo, otherwise from cache
  let history;
  try {
    const today      = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const [p1, p2] = [oneYearAgo, today].map(d => d.toISOString().slice(0,10));
    history = await yahoo.historical(symbol, { period1: p1, period2: p2, interval:'1d' });
    if (!Array.isArray(history) || history.length === 0) {
      throw new Error('Empty from Yahoo');
    }
    // Normalize shape to { date, close }
    history = history.map(r => ({ date: r.date.toISOString().slice(0,10), close: r.close }));
  } catch {
    // fallback to your CSV cache
    const cached = getCachedHistoricalData(symbol);
    if (!cached || cached.length === 0) {
      return {
        symbol,
        technical: [],
        instructions: ['No price history available.'],
        chartUrl: ''
      };
    }
    // cached rows have `.date` (string) and `.close`
    history = cached.map(r => ({ date: r.date, close: r.close }));
  }

  // 2) Build arrays
  const dates  = history.map(r => r.date);
  const closes = history.map(r => r.close);

  // 3) Compute indicators
  const sma20   = SMA.calculate({ period:20, values:closes });
  const ema50   = EMA.calculate({ period:50, values:closes });
  const rsi14   = RSI.calculate({ period:14, values:closes });
  const macdArr = MACD.calculate({ values:closes, fastPeriod:12, slowPeriod:26, signalPeriod:9 });

  // 4) Combine rows and drop nulls
  const raw = dates.map((d,i) => ({
    date: d,
    close: closes[i],
    sma20:  i >= 19 ? sma20[i-19] : null,
    ema50:  i >= 49 ? ema50[i-50] : null,
    rsi14:  i >= 13 ? rsi14[i-14] : null,
    macd:   i >= 26 ? macdArr[i-26] : null
  }));
  const data = raw.filter(r => r.sma20 !== null && r.ema50 !== null && r.rsi14 !== null);

  // 5) Search last 30 bars for explicit buy/sell signals
  const last30 = data.slice(-30);
  let buySignal = null, sellSignal = null;
  for (let i = 1; i < last30.length; i++) {
    const prev = last30[i-1], curr = last30[i];
    if (!buySignal &&
        prev.close <= prev.sma20 && prev.close <= prev.ema50 &&
        curr.close  > curr.sma20 && curr.close  > curr.ema50) {
      buySignal = {
        date: curr.date,
        price: +curr.close.toFixed(2),
        stop:  +(curr.sma20 * 0.98).toFixed(2),
        reason: 'Bullish SMA/EMA crossover'
      };
    }
    if (!buySignal && curr.rsi14 < 30) {
      buySignal = {
        date: curr.date,
        price: +curr.close.toFixed(2),
        stop:  +(curr.sma20 * 0.98).toFixed(2),
        reason: 'RSI14 < 30 (oversold)'
      };
    }
    if (!sellSignal &&
        prev.close >= prev.sma20 && prev.close >= prev.ema50 &&
        curr.close  < curr.sma20 && curr.close  < curr.ema50) {
      sellSignal = {
        date: curr.date,
        price: +curr.close.toFixed(2),
        reason: 'Bearish SMA/EMA crossover'
      };
    }
    if (!sellSignal && curr.rsi14 > 70) {
      sellSignal = {
        date: curr.date,
        price: +curr.close.toFixed(2),
        reason: 'RSI14 > 70 (overbought)'
      };
    }
    if (buySignal && sellSignal) break;
  }

  // 6) Forced fallback on the very last bar
  const last = data[data.length - 1];
  if (!buySignal && !sellSignal) {
    if (last.close >= last.sma20) {
      buySignal = {
        date: last.date,
        price: +last.close.toFixed(2),
        stop:  +(last.sma20 * 0.98).toFixed(2),
        reason: 'Close ≥ SMA20 (bullish bias)'
      };
    } else {
      sellSignal = {
        date: last.date,
        price: +last.close.toFixed(2),
        reason: 'Close < SMA20 (bearish bias)'
      };
    }
  }

  // 7) Build instructions
  const instructions = [];
  if (buySignal) {
    instructions.push(
      `On ${buySignal.date}: **BUY** limit $${buySignal.price} ` +
      `(reason: ${buySignal.reason}), set stop-loss at $${buySignal.stop}.`
    );
  }
  if (sellSignal) {
    instructions.push(
      `On ${sellSignal.date}: **SELL** at market/limit $${sellSignal.price} ` +
      `(reason: ${sellSignal.reason}).`
    );
  }

  // 8) Generate chart URL
  const chartUrl = new QuickChart()
    .setConfig({
      type: 'line',
      data: {
        labels: data.map(r => r.date),
        datasets: [
          { label:'Close', data: data.map(r => r.close), fill:false },
          { label:'SMA20', data: data.map(r => r.sma20), fill:false },
          { label:'EMA50', data: data.map(r => r.ema50), fill:false }
        ]
      },
      options: {
        title: { display:true, text:`${symbol} Price & SMA/EMA` },
        scales: { xAxes: [{ type:'time', time:{ unit:'day' } }] }
      }
    })
    .setWidth(800)
    .setHeight(400)
    .getUrl();

  return { symbol, technical: data, instructions, chartUrl };
}

module.exports = { getTechnical };

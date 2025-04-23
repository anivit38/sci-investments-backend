// backend/data/updateCSV.js
/*******************************************
 * updateCSV.js  (with daily news sentiment,
 *   plus Bollinger Bands & ATR14)
 *******************************************/
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fs        = require("fs");
const path      = require("path");
const yahoo     = require("yahoo-finance2").default;
const fetch     = require("node-fetch");
const RSSParser = require("rss-parser");
const Sentiment = require("sentiment");

const rss       = new RSSParser();
const sentiment = new Sentiment();

const HIST_CSV   = path.join(__dirname, "historicalData.csv");
const SYMBOLS_J  = path.join(__dirname, "../symbols.json");

const LOOKBACK_DAYS         = 45;
const TRADING_DAYS_REQUIRED = 30;
const MAX_LINES_PER_SYMBOL  = 60;

// ─── News Sentiment Helpers ───────────────────────────────────────
// Cache each symbol’s feed so we only fetch once
const rssCache = {};
async function getFeed(symbol) {
  if (!rssCache[symbol]) {
    const url = `https://news.google.com/rss/search?q=${symbol}`;
    rssCache[symbol] = await rss.parseURL(url);
  }
  return rssCache[symbol];
}

// Analyze up to 3 articles on the given date; returns avg sentiment + event flags
async function sentimentForDate(symbol, dateStr) {
  try {
    const feed = await getFeed(symbol);
    const dayStart = new Date(dateStr).getTime();
    const dayEnd   = dayStart + 24 * 60 * 60 * 1000;
    const items = feed.items
      .filter(it => {
        if (!it.pubDate) return false;
        const t = new Date(it.pubDate).getTime();
        return t >= dayStart && t < dayEnd;
      })
      .slice(0, 3);

    if (items.length === 0) {
      return { dailySentiment: 0, tariffEvent:0, earningsEvent:0, mergerEvent:0, regulationEvent:0 };
    }

    let sum = 0;
    let flags = { tariffEvent:0, earningsEvent:0, mergerEvent:0, regulationEvent:0 };

    for (const it of items) {
      const txt = (it.contentSnippet || it.title || "").toLowerCase();
      if (txt.includes("tariff")) flags.tariffEvent = 1;
      if (txt.includes("earnings") || txt.includes("revenue")) flags.earningsEvent = 1;
      if (txt.includes("merger")  || txt.includes("acqui"))     flags.mergerEvent   = 1;
      if (txt.includes("regulator")|| txt.includes("sec"))      flags.regulationEvent = 1;

      sum += sentiment.analyze(txt).score;
    }

    return { dailySentiment: sum / items.length, ...flags };
  } catch (e) {
    console.warn("News sentiment error for", symbol, dateStr, e.message);
    return { dailySentiment:0, tariffEvent:0, earningsEvent:0, mergerEvent:0, regulationEvent:0 };
  }
}

// ─── Helpers for Technical Indicators ─────────────────────────────
function calculateSMA(data, period, i) {
  if (i < period - 1) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += data[k].close;
  return sum / period;
}
function calculateRSI(data, period, i) {
  if (i < period) return 0;
  let gains = 0, losses = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const d = data[k].close - data[k-1].close;
    if (d > 0) gains  += d;
    else        losses += -d;
  }
  if (losses === 0) return 100;
  const rs = (gains/period) / (losses/period);
  return 100 - (100 / (1 + rs));
}
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].close;
  ema[period-1] = sum / period;
  for (let i = period; i < data.length; i++) {
    ema[i] = data[i].close * k + ema[i-1] * (1 - k);
  }
  return ema;
}
function calculateMACD(data) {
  if (data.length < 26) return data.map(_=>0);
  const e12 = calculateEMA(data, 12);
  const e26 = calculateEMA(data, 26);
  return data.map((_, i) => (e12[i]||0) - (e26[i]||0));
}

// ─── New: Bollinger Bands (20‑day ±2σ) ───────────────────────────
function computeBollinger(data, period = 20, mult = 2) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      out.push({ upper: 0, lower: 0 });
      continue;
    }
    const slice = data.slice(i - period + 1, i + 1).map(d => d.close);
    const mean  = slice.reduce((a,b)=>a+b,0) / period;
    const std   = Math.sqrt(slice.reduce((s,v)=>s+(v - mean)**2, 0)/period);
    out.push({ upper: mean + mult*std, lower: mean - mult*std });
  }
  return out;
}

// ─── New: ATR14 ───────────────────────────────────────────────────
function computeATR(data, period = 14) {
  const tr = data.map((d,i) => {
    if (i === 0) return 0;
    const prev = data[i-1].close;
    return Math.max(
      d.high - d.low,
      Math.abs(d.high - prev),
      Math.abs(d.low  - prev)
    );
  });
  return tr.map((_, i) => {
    if (i < period - 1) return 0;
    const slice = tr.slice(i - period + 1, i + 1);
    return slice.reduce((a,b)=>a+b, 0) / period;
  });
}

// ─── Main CSV Updating ─────────────────────────────────────────────
async function updateCSV() {
  if (!fs.existsSync(SYMBOLS_J)) {
    console.error("❌ symbols.json not found at", SYMBOLS_J);
    process.exit(1);
  }
  const symbols = JSON.parse(fs.readFileSync(SYMBOLS_J, "utf8"));

  const today     = new Date();
  const endDate   = new Date(today.getTime() - 24*60*60*1000);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - LOOKBACK_DAYS + 1);
  console.log(`✏️  Fetching data from ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)}`);

  const header = [
    "symbol","date","open","high","low","close","volume",
    "peRatio","earningsGrowth","debtToEquity","revenue","netIncome",
    "SMA20","RSI14","MACD",
    "BB_upper","BB_lower","ATR14",
    "dailySentiment","tariffEvent","earningsEvent","mergerEvent","regulationEvent"
  ];
  const outRows = [];

  for (const ent of symbols) {
    const sym = typeof ent === "string" ? ent : ent.symbol;
    console.log(`\n▶️  Processing ${sym}`);
    let raw;
    try {
      const p2 = new Date(endDate); p2.setDate(p2.getDate()+1);
      raw = await yahoo.historical(sym, { period1:startDate, period2:p2, interval:"1d" });
    } catch (err) {
      console.warn(`  ⚠️  No data for ${sym}:`, err.message);
      continue;
    }
    if (!raw || raw.length === 0) {
      console.warn(`  ⚠️  ${sym} returned empty`);
      continue;
    }
    raw.sort((a,b)=>new Date(a.date)-new Date(b.date));

    // precompute all series once
    const sma20 = raw.map((_,i)=> calculateSMA(raw,20,i));
    const rsi14 = raw.map((_,i)=> calculateRSI(raw,14,i));
    const macd  = calculateMACD(raw);
    const bb    = computeBollinger(raw, 20, 2);
    const atr14 = computeATR(raw, 14);

    const recent = raw.slice(-TRADING_DAYS_REQUIRED);
    const offset = raw.length - recent.length;

    for (let j = 0; j < recent.length; j++) {
      const day = recent[j];
      const idx = offset + j;
      const dateStr = day.date.toISOString().slice(0,10);

      if ([day.open,day.high,day.low,day.close,day.volume].some(v=>v==null)) {
        continue; // skip incomplete
      }

      const news = await sentimentForDate(sym, dateStr);

      outRows.push({
        symbol: sym,
        date:   dateStr,
        open:   day.open,
        high:   day.high,
        low:    day.low,
        close:  day.close,
        volume: day.volume,
        peRatio:        day.peRatio       || 0,
        earningsGrowth: day.earningsGrowth|| 0,
        debtToEquity:   day.debtToEquity  || 0,
        revenue:        day.revenue       || 0,
        netIncome:      day.netIncome     || 0,
        SMA20:  sma20[idx]  || 0,
        RSI14:  rsi14[idx]  || 0,
        MACD:   macd[idx]   || 0,
        BB_upper: bb[idx]?.upper || 0,
        BB_lower: bb[idx]?.lower || 0,
        ATR14:    atr14[idx]    || 0,
        dailySentiment:  news.dailySentiment,
        tariffEvent:     news.tariffEvent,
        earningsEvent:   news.earningsEvent,
        mergerEvent:     news.mergerEvent,
        regulationEvent: news.regulationEvent
      });

      process.stdout.write(".");
    }
    console.log(`  → ${recent.length} rows added`);
  }

  // 5) enforce MAX_LINES_PER_SYMBOL
  const grouped = {};
  outRows.forEach(r => {
    (grouped[r.symbol] ||= []).push(r);
  });
  const finalRows = [];
  Object.values(grouped).forEach(arr => {
    arr.sort((a,b)=> new Date(a.date) - new Date(b.date));
    finalRows.push(...arr.slice(-MAX_LINES_PER_SYMBOL));
  });

  // 6) write CSV
  const lines = [
    header.join(","),
    ...finalRows.map(r => header.map(c => String(r[c]||0)).join(","))
  ].join("\n");
  fs.writeFileSync(HIST_CSV, lines, "utf8");
  console.log("\n✅ historicalData.csv updated!");
}

updateCSV().catch(e => {
  console.error("Fatal in updateCSV:", e);
  process.exit(1);
});

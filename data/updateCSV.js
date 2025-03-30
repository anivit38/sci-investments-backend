/*******************************************
 * updateCSV.js
 *
 * This script:
 * 1) Reads symbols from symbols.json
 * 2) Fetches daily data from Yahoo Finance for the specified date range.
 * 3) Fetches up to 8 quarterly income statements from FMP.
 * 4) Date‑aligns fundamentals with each daily record and computes technical indicators:
 *    – SMA20: 20‑day simple moving average of close
 *    – RSI14: 14‑day Relative Strength Index computed from close prices
 *    – MACD: Difference between the 12‑day EMA and the 26‑day EMA of close
 * 5) Keeps only the last MAX_LINES_PER_SYMBOL rows per symbol.
 * 6) Writes out a CSV with columns:
 *    symbol,date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity,revenue,netIncome,SMA20,RSI14,MACD
 *******************************************/

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const fs = require("fs");
const path = require("path");
const yahooFinance = require("yahoo-finance2").default;
const fetch = require("node-fetch");

const CSV_FILE = path.join(__dirname, "historicalData.csv");
const SYMBOLS_JSON = path.join(__dirname, "../symbols.json");

const ONE_DAY = 24 * 60 * 60 * 1000;
const TRADING_DAYS_REQUIRED = 30;  
const LOOKBACK_CALENDAR_DAYS = 45; 
const MAX_LINES_PER_SYMBOL = 45;    // Keep only the last 60 lines per symbol

// FMP API key from .env
const FMP_API_KEY = process.env.FMP_API_KEY || "YOUR_FMP_API_KEY";

/* ---------------------
   Technical Indicator Helpers
--------------------- */
// Simple Moving Average (SMA) for the 'close' price
function calculateSMA(data, period, index) {
  if (index < period - 1) return 0;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    sum += data[i].close;
  }
  return sum / period;
}

// RSI (Relative Strength Index) using period (typically 14)
function calculateRSI(data, period, index) {
  if (index < period) return 0;
  let gains = 0, losses = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const change = data[i].close - data[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Exponential Moving Average (EMA) for the 'close' price over a period
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  const emaArray = [];
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  emaArray[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    const emaYesterday = emaArray[i - 1] || data[i - 1].close;
    emaArray[i] = data[i].close * k + emaYesterday * (1 - k);
  }
  return emaArray;
}

// Compute MACD as EMA12 - EMA26 for the 'close' price
function calculateMACD(data) {
  if (data.length < 26) return [];
  const ema12 = calculateEMA(data, 12);
  const ema26 = calculateEMA(data, 26);
  const macd = [];
  for (let i = 0; i < data.length; i++) {
    if (ema12[i] === undefined || ema26[i] === undefined) {
      macd.push(0);
    } else {
      macd.push(ema12[i] - ema26[i]);
    }
  }
  return macd;
}

/* ---------------------
   Basic CSV helper functions
--------------------- */
function parseCSV(data) {
  const lines = data.trim().split("\n");
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const row = {};
    header.forEach((col, index) => {
      row[col] = values[index];
    });
    rows.push(row);
  }
  return { header, rows };
}

function convertToCSV(header, rows) {
  const lines = [];
  lines.push(header.join(","));
  for (const row of rows) {
    const line = header.map((col) => String(row[col])).join(",");
    lines.push(line);
  }
  return lines.join("\n");
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getYesterdayDate() {
  return new Date(Date.now() - ONE_DAY);
}

/**
 * Fetch daily historical data from Yahoo Finance.
 */
async function fetchHistoricalData(symbol, startDate, endDate) {
  try {
    const period2 = new Date(endDate.getTime());
    period2.setDate(period2.getDate() + 1);
    const data = await yahooFinance.historical(symbol, {
      period1: startDate,
      period2: period2,
      interval: "1d",
    });
    return data || [];
  } catch (error) {
    console.error(
      `Error fetching Yahoo data for ${symbol} between ${formatDate(startDate)} and ${formatDate(endDate)}:`,
      error.message
    );
    return [];
  }
}

/**
 * Fetch up to 8 quarterly income statements from FMP.
 */
async function fetchStatementsFMP(symbol, limit = 8) {
  if (!FMP_API_KEY || FMP_API_KEY === "YOUR_FMP_API_KEY") {
    console.warn("No FMP_API_KEY found. Skipping fundamentals fetch.");
    return [];
  }
  const url = `https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=${limit}&apikey=${FMP_API_KEY}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`No FMP statements for ${symbol}`);
      return [];
    }
    // Sort ascending by statement date
    data.sort((a, b) => new Date(a.date) - new Date(b.date));
    return data;
  } catch (err) {
    console.error(`Error fetching fundamentals for ${symbol}:`, err.message);
    return [];
  }
}

/**
 * For a given sorted array of statements and a daily date,
 * return the most recent statement with date <= daily date.
 */
function findStatementForDate(statements, dailyDate) {
  let result = null;
  const dailyTime = new Date(dailyDate).getTime();
  for (const st of statements) {
    const stTime = new Date(st.date).getTime();
    if (stTime <= dailyTime) {
      result = st;
    } else {
      break;
    }
  }
  return result;
}

async function updateCSV() {
  // 1) Load symbols
  if (!fs.existsSync(SYMBOLS_JSON)) {
    console.error("❌ symbols.json not found at:", SYMBOLS_JSON);
    return;
  }
  let symbols = [];
  try {
    const rawSymbols = fs.readFileSync(SYMBOLS_JSON, "utf-8");
    symbols = JSON.parse(rawSymbols);
  } catch (err) {
    console.error("❌ Error reading symbols.json:", err.message);
    return;
  }

  // 2) Prepare CSV header and start with an empty rows array (ignore any old file)
  const header = [
    "symbol",
    "date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "peRatio",
    "earningsGrowth",
    "debtToEquity",
    "revenue",
    "netIncome",
    "SMA20",
    "RSI14",
    "MACD"
  ];
  let rows = []; // start fresh

  // 3) Determine date range for Yahoo fetch
  const endDate = getYesterdayDate();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - LOOKBACK_CALENDAR_DAYS + 1);
  console.log(`⏳ Fetching daily data from ${formatDate(startDate)} to ${formatDate(endDate)}...`);

  // 4) Process each symbol
  for (const s of symbols) {
    const symbol = typeof s === "string" ? s : s.symbol;
    let fetchSymbol = symbol;
    if (s.exchange && s.exchange.toUpperCase() === "TSX") {
      fetchSymbol = symbol + ".TO";
    }
    console.log(`\n--- Processing ${symbol} (fetching as ${fetchSymbol}) ---`);

    // A) Fetch daily historical data from Yahoo
    const historicalData = await fetchHistoricalData(fetchSymbol, startDate, endDate);
    if (!historicalData || historicalData.length === 0) {
      console.warn(`No daily data found for ${symbol}. Skipping.`);
      continue;
    }
    historicalData.sort((a, b) => new Date(a.date) - new Date(b.date));

    // B) Compute technical indicators on the full daily dataset
    const sma20Array = historicalData.map((_, i) => calculateSMA(historicalData, 20, i));
    const rsi14Array = historicalData.map((_, i) => calculateRSI(historicalData, 14, i));
    const macdArray = calculateMACD(historicalData);

    // C) Fetch quarterly income statements from FMP
    const statements = await fetchStatementsFMP(symbol, 8);
    
    // Keep the last TRADING_DAYS_REQUIRED daily records
    const recentData = historicalData.slice(-TRADING_DAYS_REQUIRED);
    if (recentData.length < TRADING_DAYS_REQUIRED) {
      console.warn(`⚠️ ${symbol} has only ${recentData.length} trading days in the last ${LOOKBACK_CALENDAR_DAYS} days.`);
    }
    const recentStartIndex = historicalData.length - recentData.length;

    // D) For each day in the recent data, add fundamentals and technical indicators
    for (let j = 0; j < recentData.length; j++) {
      const day = recentData[j];
      const index = recentStartIndex + j;
      const dateStr = formatDate(new Date(day.date));
      let st = findStatementForDate(statements, dateStr);
      if (!st) {
        st = { revenue: 0, netIncome: 0 };
      }
      const newRow = {
        symbol,
        date: dateStr,
        open: day.open,
        high: day.high,
        low: day.low,
        close: day.close,
        volume: day.volume,
        peRatio: day.peRatio || 0,
        earningsGrowth: day.earningsGrowth || 0,
        debtToEquity: day.debtToEquity || 0,
        revenue: st.revenue || 0,
        netIncome: st.netIncome || 0,
        SMA20: sma20Array[index] || 0,
        RSI14: rsi14Array[index] || 0,
        MACD: macdArray[index] || 0
      };

      // Always add the new row (we are rebuilding the CSV from scratch)
      rows.push(newRow);
      console.log(`Added: ${symbol} on ${dateStr}`);
    }
  }

  // 5) Group by symbol and keep only the last MAX_LINES_PER_SYMBOL rows per symbol
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.symbol]) grouped[row.symbol] = [];
    grouped[row.symbol].push(row);
  }
  const updatedRows = [];
  for (const sym in grouped) {
    grouped[sym].sort((a, b) => new Date(a.date) - new Date(b.date));
    const keep = grouped[sym].slice(-MAX_LINES_PER_SYMBOL);
    updatedRows.push(...keep);
  }

  // 6) Write out the updated CSV file
  const csvContent = convertToCSV(header, updatedRows);
  fs.writeFileSync(CSV_FILE, csvContent, "utf-8");
  console.log("\n✅ CSV file updated successfully!");
}

// 7) Run the update
updateCSV();

// updateCSV.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const yahooFinance = require("yahoo-finance2").default;

const CSV_FILE = path.join(__dirname, "historicalData.csv");

// We assume symbols.json is one level up: ../symbols.json
const SYMBOLS_JSON = path.join(__dirname, "../symbols.json");

const ONE_DAY = 24 * 60 * 60 * 1000;
const TRADING_DAYS_REQUIRED = 30;
const LOOKBACK_CALENDAR_DAYS = 45; // look back ~45 calendar days

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
      `Error fetching data for ${symbol} between ${formatDate(startDate)} and ${formatDate(endDate)}:`,
      error.message
    );
    return [];
  }
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

  // 2) Prepare CSV
  let header = [
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
  ];
  let rows = [];
  if (fs.existsSync(CSV_FILE)) {
    try {
      const csvData = fs.readFileSync(CSV_FILE, "utf-8");
      const parsed = parseCSV(csvData);
      header = parsed.header;
      rows = parsed.rows;
    } catch (err) {
      console.error("❌ Error reading CSV file:", err.message);
      return;
    }
  }

  // 3) Determine date range
  const endDate = getYesterdayDate();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - LOOKBACK_CALENDAR_DAYS + 1);

  console.log(`⏳ Fetching data from ${formatDate(startDate)} to ${formatDate(endDate)}...`);

  // 4) For each symbol, fetch and keep the last 30 trading days
  for (const stock of symbols) {
    // stock can be a string or an object with a symbol and exchange property.
    const symbol = typeof stock === "string" ? stock : stock.symbol;
    // Determine which ticker to fetch.
    let fetchSymbol = symbol;
    if (stock.exchange && stock.exchange.toUpperCase() === "TSX") {
      // Append .TO for TSX symbols on Yahoo Finance.
      fetchSymbol = symbol + ".TO";
    }
    console.log(`\n--- Processing ${symbol} (fetching as ${fetchSymbol}) ---`);

    const historicalData = await fetchHistoricalData(fetchSymbol, startDate, endDate);
    if (!historicalData || historicalData.length === 0) {
      console.warn(`No data found for ${symbol}. Skipping.`);
      continue;
    }

    // Sort ascending
    historicalData.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Keep the last 30 trading days from that range
    const recentData = historicalData.slice(-TRADING_DAYS_REQUIRED);
    if (recentData.length < TRADING_DAYS_REQUIRED) {
      console.warn(`⚠️  ${symbol} only has ${recentData.length} trading days in the last ${LOOKBACK_CALENDAR_DAYS} days.`);
    }

    for (const day of recentData) {
      const dateStr = formatDate(new Date(day.date));
      const newRow = {
        symbol, // use original symbol
        date: dateStr,
        open: day.open,
        high: day.high,
        low: day.low,
        close: day.close,
        volume: day.volume,
        peRatio: day.peRatio || 0,
        earningsGrowth: day.earningsGrowth || 0,
        debtToEquity: day.debtToEquity || 0,
      };

      // Insert if not exists
      const exists = rows.some((r) => r.symbol === symbol && r.date === dateStr);
      if (!exists) {
        rows.push(newRow);
        console.log(`Added: ${symbol} on ${dateStr}`);
      } else {
        console.log(`Already exists: ${symbol} on ${dateStr}`);
      }
    }
  }

  // 5) Group by symbol, keep only the latest 30
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.symbol]) grouped[row.symbol] = [];
    grouped[row.symbol].push(row);
  }

  const updatedRows = [];
  for (const sym in grouped) {
    grouped[sym].sort((a, b) => new Date(a.date) - new Date(b.date));
    const keep = grouped[sym].slice(-TRADING_DAYS_REQUIRED);
    updatedRows.push(...keep);
  }

  // 6) Write out CSV
  const csvContent = convertToCSV(header, updatedRows);
  fs.writeFileSync(CSV_FILE, csvContent, "utf-8");
  console.log("\n✅ CSV file updated successfully!");
}

// 7) Run it
updateCSV();

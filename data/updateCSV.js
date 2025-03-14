// updateCSV.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const yahooFinance = require("yahoo-finance2").default;

const SYMBOLS_JSON = path.join(__dirname, "../symbols.json"); // Your JSON file with stock symbols
const CSV_FILE = path.join(__dirname, "historicalData.csv"); // Single CSV file for all stocks
const ONE_DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 30; // We want 30 days per stock

// Helper function to parse CSV (assumes no commas within fields)
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

// Helper function to convert rows back to a CSV string
function convertToCSV(header, rows) {
  const lines = [];
  lines.push(header.join(","));
  for (const row of rows) {
    // Convert all values to string
    const line = header.map(col => String(row[col])).join(",");
    lines.push(line);
  }
  return lines.join("\n");
}

// Helper function to get yesterday's date as YYYY-MM-DD
function getYesterdayDateString() {
  const yesterday = new Date(Date.now() - ONE_DAY);
  const year = yesterday.getFullYear();
  const month = String(yesterday.getMonth() + 1).padStart(2, "0");
  const day = String(yesterday.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Fetch historical data for a given symbol and date
async function fetchDailyData(symbol, dateStr) {
  try {
    const period1 = new Date(dateStr);
    // Yahoo Finance requires the period2 to be later than period1.
    const period2 = new Date(dateStr);
    period2.setDate(period2.getDate() + 1);
    const data = await yahooFinance.historical(symbol, {
      period1,
      period2,
      interval: "1d",
    });
    if (data && data.length > 0) {
      return data[0]; // Return the one day of data
    }
    return null;
  } catch (error) {
    console.error(`Error fetching data for ${symbol} on ${dateStr}:`, error.message);
    return null;
  }
}

async function updateCSV() {
  // Load symbols from symbols.json
  let symbols = [];
  if (fs.existsSync(SYMBOLS_JSON)) {
    try {
      const rawSymbols = fs.readFileSync(SYMBOLS_JSON, "utf-8");
      symbols = JSON.parse(rawSymbols);
    } catch (err) {
      console.error("Error reading symbols.json:", err.message);
      return;
    }
  } else {
    console.error("symbols.json not found");
    return;
  }

  // Define the CSV header
  let header = ["symbol", "date", "open", "high", "low", "close", "volume", "peRatio", "earningsGrowth", "debtToEquity"];
  let rows = [];
  if (fs.existsSync(CSV_FILE)) {
    try {
      const csvData = fs.readFileSync(CSV_FILE, "utf-8");
      const parsed = parseCSV(csvData);
      header = parsed.header;
      rows = parsed.rows;
    } catch (err) {
      console.error("Error reading CSV file:", err.message);
      return;
    }
  }

  const dateStr = getYesterdayDateString();
  console.log("Updating CSV for date:", dateStr);

  // For each symbol, fetch yesterday's data and add it if it doesn't exist already.
  for (const stock of symbols) {
    // symbols.json may contain objects with a property "symbol" or just strings.
    const symbol = typeof stock === "string" ? stock : stock.symbol;
    console.log(`Processing ${symbol}...`);
    const dailyData = await fetchDailyData(symbol, dateStr);
    if (!dailyData) {
      console.log(`No data for ${symbol} on ${dateStr}`);
      continue;
    }
    // Build a new row (you may need to adjust the fields based on your available data)
    const newRow = {
      symbol,
      date: dateStr,
      open: dailyData.open,
      high: dailyData.high,
      low: dailyData.low,
      close: dailyData.close,
      volume: dailyData.volume,
      // If these fundamentals aren’t provided by Yahoo Finance's historical endpoint,
      // you might fill in with 0 or fetch from another source.
      peRatio: dailyData.peRatio || 0,
      earningsGrowth: dailyData.earningsGrowth || 0,
      debtToEquity: dailyData.debtToEquity || 0,
    };

    // Check for an existing row with the same symbol and date (to avoid duplicates)
    const exists = rows.some(row => row.symbol === symbol && row.date === dateStr);
    if (!exists) {
      rows.push(newRow);
      console.log(`Added data for ${symbol} on ${dateStr}`);
    } else {
      console.log(`Data for ${symbol} on ${dateStr} already exists`);
    }
  }

  // Group rows by symbol and trim to the latest 30 entries per stock
  const updatedRows = [];
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.symbol]) {
      grouped[row.symbol] = [];
    }
    grouped[row.symbol].push(row);
  }
  for (const symbol in grouped) {
    grouped[symbol].sort((a, b) => new Date(a.date) - new Date(b.date));
    const recent = grouped[symbol].slice(-MAX_DAYS);
    updatedRows.push(...recent);
  }

  // Convert the updated rows back into CSV format and write to the file
  const csvContent = convertToCSV(header, updatedRows);
  fs.writeFileSync(CSV_FILE, csvContent, "utf-8");
  console.log("CSV file updated successfully.");
}

// Run the update process
updateCSV();

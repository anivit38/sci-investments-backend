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

// Helper function to format a Date as YYYY-MM-DD
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Helper function to get yesterday's date as a Date object
function getYesterdayDate() {
  return new Date(Date.now() - ONE_DAY);
}

// Fetch historical data for a given symbol from startDate to endDate (inclusive)
async function fetchHistoricalData(symbol, startDate, endDate) {
  try {
    // Yahoo Finance's historical API expects period2 to be the day after the last day.
    const period2 = new Date(endDate.getTime());
    period2.setDate(period2.getDate() + 1);
    const data = await yahooFinance.historical(symbol, {
      period1: startDate,
      period2: period2,
      interval: "1d",
    });
    return data; // returns an array of daily data
  } catch (error) {
    console.error(
      `Error fetching data for ${symbol} from ${formatDate(startDate)} to ${formatDate(endDate)}:`,
      error.message
    );
    return [];
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

  // Determine the 30-day window (ending with yesterday)
  const endDate = getYesterdayDate(); // yesterday as Date object
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - MAX_DAYS + 1);

  console.log(`Updating CSV for dates between ${formatDate(startDate)} and ${formatDate(endDate)}`);

  // For each symbol, fetch historical data for the 30-day range and add new rows if they don't exist
  for (const stock of symbols) {
    // symbols.json may contain objects with a property "symbol" or just strings.
    const symbol = typeof stock === "string" ? stock : stock.symbol;
    console.log(`Processing ${symbol}...`);
    const historicalData = await fetchHistoricalData(symbol, startDate, endDate);
    if (!historicalData || historicalData.length === 0) {
      console.log(`No data for ${symbol} from ${formatDate(startDate)} to ${formatDate(endDate)}`);
      continue;
    }
    for (const dailyData of historicalData) {
      // Format the date as YYYY-MM-DD
      const dateObj = new Date(dailyData.date);
      const dateStr = formatDate(dateObj);
      // Build a new row (adjust fields as needed)
      const newRow = {
        symbol,
        date: dateStr,
        open: dailyData.open,
        high: dailyData.high,
        low: dailyData.low,
        close: dailyData.close,
        volume: dailyData.volume,
        // Use provided fundamentals if available; otherwise, default to 0.
        peRatio: dailyData.peRatio || 0,
        earningsGrowth: dailyData.earningsGrowth || 0,
        debtToEquity: dailyData.debtToEquity || 0,
      };
      // Check if an entry for this symbol and date already exists.
      const exists = rows.some(row => row.symbol === symbol && row.date === dateStr);
      if (!exists) {
        rows.push(newRow);
        console.log(`Added data for ${symbol} on ${dateStr}`);
      } else {
        console.log(`Data for ${symbol} on ${dateStr} already exists`);
      }
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
    // Sort the rows by date in ascending order
    grouped[symbol].sort((a, b) => new Date(a.date) - new Date(b.date));
    // Keep only the latest MAX_DAYS rows
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

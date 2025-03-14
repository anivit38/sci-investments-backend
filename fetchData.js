/*******************************************************
 * fetchData.js
 * 
 * Responsible for:
 *   - In-memory caching of historicalData.csv
 *   - Exports getCachedHistoricalData(symbol)
 *   - Optionally fetching from Yahoo if needed (not strictly used if you rely on updateCSV.js)
 *******************************************************/

const fs = require("fs");
const path = require("path");
const yahooFinance = require("yahoo-finance2").default;

// This will hold an array of rows for each symbol
//   e.g. historicalDataCache["AAPL"] = [{ date, open, high, ... }, ...]
const historicalDataCache = {};

/**
 * Loads historicalData.csv into memory (historicalDataCache).
 * Call this at server startup so advanced forecasting can read from it.
 */
function loadHistoricalDataFromCSV() {
  const csvPath = path.join(__dirname, "historicalData.csv");
  if (!fs.existsSync(csvPath)) {
    console.warn("⚠️  No historicalData.csv found, so advanced forecasting may have no data.");
    return;
  }
  console.log("Loading historicalData.csv into memory...");
  const csvData = fs.readFileSync(csvPath, "utf-8").trim();
  const lines = csvData.split("\n");
  if (lines.length < 2) {
    console.warn("⚠️  historicalData.csv is empty or invalid header.");
    return;
  }

  const header = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
    const values = line.split(",");
    const rowObj = {};
    header.forEach((col, i) => {
      rowObj[col] = values[i];
    });
    return rowObj;
  });

  // Group by symbol
  const grouped = {};
  for (const row of rows) {
    const sym = row.symbol;
    if (!grouped[sym]) grouped[sym] = [];
    // Convert numeric fields as needed
    grouped[sym].push({
      symbol: row.symbol,
      date: row.date,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
      peRatio: parseFloat(row.peRatio),
      earningsGrowth: parseFloat(row.earningsGrowth),
      debtToEquity: parseFloat(row.debtToEquity),
    });
  }

  // Store in historicalDataCache
  for (const sym in grouped) {
    // Sort ascending by date, just in case
    grouped[sym].sort((a, b) => new Date(a.date) - new Date(b.date));
    historicalDataCache[sym] = grouped[sym];
  }
  console.log("✅ historicalDataCache loaded with", Object.keys(grouped).length, "symbols.");
}

/**
 * Return the array of daily data objects for the given symbol from in-memory cache.
 * Each object has {symbol,date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity}.
 */
function getCachedHistoricalData(symbol) {
  return historicalDataCache[symbol] || [];
}

/**
 * Optional: fetch historical data directly from Yahoo (if you want).
 * Not strictly required if you rely on updateCSV.js to populate the CSV.
 */
async function fetchHistoricalData(symbol, yearsBack = 1) {
  // ...
  // Implementation omitted or minimal. Typically you'd do yahooFinance.historical here.
  // ...
  return []; // or real data
}

/**
 * Optional: fetch for multiple symbols (1 year, etc.).
 * updateCSV.js typically does this too, so you may not need it.
 */
async function fetchAllSymbolsHistoricalData(symbols, yearsBack = 1) {
  // ...
  // Implementation omitted or minimal
}

module.exports = {
  loadHistoricalDataFromCSV,
  getCachedHistoricalData,
  historicalDataCache,
  // The following are optional if used in other places
  fetchHistoricalData,
  fetchAllSymbolsHistoricalData,
};

// If you want to allow "node fetchData.js" to test, you can do:
if (require.main === module) {
  console.log("Running fetchData.js standalone...");
  loadHistoricalDataFromCSV();
  console.log("Done. You can console.log(...) to inspect historicalDataCache if needed.");
}

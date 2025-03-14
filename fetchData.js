/*******************************************************
 * fetchData.js
 * 
 * Provides:
 *   - historicalDataCache: an in-memory object 
 *   - loadCsvIntoMemory(): read the CSV, parse, store in memory
 *   - getCachedHistoricalData(symbol)
 *   - storeInMemoryData(symbol, dataArray)
 *   - fetchHistoricalData, fetchAllSymbolsHistoricalData (if you want)
 *******************************************************/
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const yahooFinance = require("yahoo-finance2").default;

/** The in-memory object for storing historical data:
 *   historicalDataCache[symbol] = array of daily objects
 */
const historicalDataCache = {};

/** The path to your CSV file */
const CSV_FILE = path.join(__dirname, "historicalData.csv");

/** 
 * Helper to parse CSV lines.
 * We assume the CSV has a header like:
 *   symbol,date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity
 */
function loadCsvIntoMemory() {
  if (!fs.existsSync(CSV_FILE)) {
    console.warn(`No CSV file found at ${CSV_FILE}. Skipping loadCsvIntoMemory().`);
    return;
  }
  console.log(`Loading CSV into memory from: ${CSV_FILE}`);
  const raw = fs.readFileSync(CSV_FILE, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length <= 1) {
    console.warn("CSV file is empty or has no data rows.");
    return;
  }
  const header = lines[0].split(",");
  // We expect something like:
  //  0: symbol
  //  1: date
  //  2: open
  //  3: high
  //  4: low
  //  5: close
  //  6: volume
  //  7: peRatio
  //  8: earningsGrowth
  //  9: debtToEquity

  // We'll figure out each column index:
  const colIndex = {};
  header.forEach((colName, idx) => {
    colIndex[colName] = idx;
  });

  // Now parse each data row
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    if (row.length < 2) continue; // skip blank lines

    const symbol = row[colIndex["symbol"]];
    const dateStr = row[colIndex["date"]];
    const open = parseFloat(row[colIndex["open"]]) || 0;
    const high = parseFloat(row[colIndex["high"]]) || 0;
    const low = parseFloat(row[colIndex["low"]]) || 0;
    const close = parseFloat(row[colIndex["close"]]) || 0;
    const volume = parseFloat(row[colIndex["volume"]]) || 0;
    const peRatio = parseFloat(row[colIndex["peRatio"]]) || 0;
    const earningsGrowth = parseFloat(row[colIndex["earningsGrowth"]]) || 0;
    const debtToEquity = parseFloat(row[colIndex["debtToEquity"]]) || 0;

    if (!historicalDataCache[symbol]) {
      historicalDataCache[symbol] = [];
    }
    historicalDataCache[symbol].push({
      date: dateStr,
      open,
      high,
      low,
      close,
      volume,
      peRatio,
      earningsGrowth,
      debtToEquity,
    });
  }

  // (Optional) sort each symbol’s array ascending by date
  for (const sym in historicalDataCache) {
    historicalDataCache[sym].sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  console.log("Finished loading CSV into memory. Symbols loaded:", Object.keys(historicalDataCache).length);
}

/**
 * getCachedHistoricalData(symbol)
 * Return the array from memory, or empty if none.
 */
function getCachedHistoricalData(symbol) {
  return historicalDataCache[symbol] || [];
}

/**
 * storeInMemoryData(symbol, dataArray)
 * Overwrite or merge data in memory for that symbol
 */
function storeInMemoryData(symbol, dataArray) {
  // You might want to merge with existing data. 
  // For simplicity, let's just overwrite:
  historicalDataCache[symbol] = dataArray;
  // But if you want to do a merge, you'd do something like:
  //   combined = existing + dataArray => remove duplicates => sort => store
}

/** 
 * fetchHistoricalData(symbol, yearsBack = 1)
 * Example function if you want to fetch from Yahoo for up to 'yearsBack'
 */
async function fetchHistoricalData(symbol, yearsBack = 1) {
  const now = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - yearsBack);
  try {
    const results = await yahooFinance.historical(symbol, {
      period1: start,
      period2: now,
      interval: "1d",
    });
    return results || [];
  } catch (err) {
    console.error(`Error in fetchHistoricalData for ${symbol}:`, err.message);
    return [];
  }
}

/** 
 * fetchAllSymbolsHistoricalData(symbols, yearsBack = 1)
 * For each symbol in 'symbols', fetch up to 'yearsBack' of data from Yahoo,
 * then store in memory (and optionally append to CSV).
 */
async function fetchAllSymbolsHistoricalData(symbols, yearsBack = 1) {
  for (const s of symbols) {
    const symbol = typeof s === "string" ? s : s.symbol;
    console.log(`fetchAllSymbolsHistoricalData: fetching for ${symbol}...`);
    const data = await fetchHistoricalData(symbol, yearsBack);
    if (data && data.length > 0) {
      // Convert to your shape
      const shaped = data.map((d) => ({
        date: d.date.toISOString().substr(0, 10),
        open: d.open || 0,
        high: d.high || 0,
        low: d.low || 0,
        close: d.close || 0,
        volume: d.volume || 0,
        peRatio: 0,
        earningsGrowth: 0,
        debtToEquity: 0,
      }));
      shaped.sort((a, b) => new Date(a.date) - new Date(b.date));
      // Store in memory
      storeInMemoryData(symbol, shaped);
      // Optionally append to CSV or rewrite CSV
      // ...
    } else {
      console.warn(`No data fetched for ${symbol}.`);
    }
  }
}

// Export
module.exports = {
  loadCsvIntoMemory,
  getCachedHistoricalData,
  storeInMemoryData,
  fetchHistoricalData,
  fetchAllSymbolsHistoricalData,
  historicalDataCache,
};

// If run standalone: node fetchData.js
if (require.main === module) {
  console.log("Running fetchData.js standalone...");
  loadCsvIntoMemory();
  console.log("Done. You now have historicalDataCache filled from CSV.");
}

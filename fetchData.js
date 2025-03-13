/*******************************************************
 * fetchData.js
 * ...
 *******************************************************/

const yahooFinance = require("yahoo-finance2").default;
const fs = require("fs");

const historicalDataCache = {};

/* ... (the existing exports) ... */

async function fetchHistoricalData(symbol, yearsBack = 1) {
  // same as before
}

async function fetchAllSymbolsHistoricalData(symbols, yearsBack = 1) {
  // same as before
}

function getCachedHistoricalData(symbol) {
  return historicalDataCache[symbol] || [];
}

// 1) Export as usual
module.exports = {
  fetchHistoricalData,
  fetchAllSymbolsHistoricalData,
  getCachedHistoricalData,
  historicalDataCache,
};

// 2) If you want to see logs by running "node fetchData.js",
//    add a check at the bottom:
if (require.main === module) {
  (async () => {
    // For example, read your symbols.json
    try {
      const symbolsPath = require("path").join(__dirname, "symbols.json");
      if (!fs.existsSync(symbolsPath)) {
        console.log("No symbols.json found, nothing to do.");
        return;
      }
      const symbolsRaw = fs.readFileSync(symbolsPath, "utf-8");
      const symbols = JSON.parse(symbolsRaw);

      // Then call our function to fetch 1 year of data:
      await fetchAllSymbolsHistoricalData(symbols, 1);
      console.log("✅ Done fetching historical data (standalone).");
    } catch (err) {
      console.error("❌ Error in standalone fetchData.js run:", err.message);
    }
  })();
}

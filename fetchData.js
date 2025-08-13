/*******************************************************
 * backend/fetchData.js     (Phase‑3 version)
 *
 *  ✓ In–memory historicalDataCache
 *  ✓ loadCsvIntoMemory()          – one‑shot CSV ingest
 *  ✓ getCachedHistoricalData()    – simple accessor
 *  ✓ getWindowFromBucket()        – 30 × 17 matrix for GRU
 *  ✓ fetchHistoricalData()        – Yahoo helper
 *  ✓ fetchAllSymbolsHistoricalData() – batch Yahoo fetch
 *
 *  Stand‑alone test:
 *      node fetchData.js
 *******************************************************/
require("dotenv").config();
const fs          = require("fs");
const path        = require("path");
const readline    = require("readline");
const yahooFinance = require("yahoo-finance2").default;

/*─────────────────────────────────────────────────────
  Shared constants (MUST match trainGRU.js & server.js)
─────────────────────────────────────────────────────*/
const LOOKBACK = 30;   // window length for the GRU
const FORECAST_FEATURE_KEYS = [
  "open","high","low","close","volume",
  "peRatio","earningsGrowth","debtToEquity","revenue","netIncome",
  "ATR14","SMA20","STD20","BB_upper","BB_lower","RSI14","MACD"
];

/*─────────────────────────────────────────────────────
  1) Simple in‑memory cache of daily rows
─────────────────────────────────────────────────────*/
const historicalDataCache = {};

/* The Phase‑3 *monolithic* enriched CSV (all symbols) */
const ENRICHED_CSV = path.join(__dirname, "data", "historicalData_enriched_full.csv");

/*─────────────────────────────────────────────────────
  2) Load the big CSV into memory at start‑up
─────────────────────────────────────────────────────*/
function loadCsvIntoMemory() {
  if (!fs.existsSync(ENRICHED_CSV)) {
    console.warn(`⚠️ ${ENRICHED_CSV} not found – skipping preload`);
    return;
  }
  console.time("CSV‑load");
  console.log(`⏳ Loading ${ENRICHED_CSV} …`);

  const raw = fs.readFileSync(ENRICHED_CSV, "utf8").trim().split("\n");
  const header = raw.shift().split(",");

  const colIndex = {};
  header.forEach((h, i) => (colIndex[h] = i));

  raw.forEach((ln) => {
    const row = ln.split(",");
    const sym = row[colIndex.symbol];
    if (!historicalDataCache[sym]) historicalDataCache[sym] = [];

    /* convert only the 17 forecast features to numbers */
    const daily = { date: row[colIndex.date] };
    FORECAST_FEATURE_KEYS.forEach((k) => {
      daily[k] = +row[colIndex[k]] || 0;
    });
    historicalDataCache[sym].push(daily);
  });

  /* ensure ascending date order */
  for (const s in historicalDataCache) {
    historicalDataCache[s].sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  console.log(`✅ CSV loaded – ${Object.keys(historicalDataCache).length} symbols`);
  console.timeEnd("CSV‑load");
}

/*─────────────────────────────────────────────────────
  3) Phase‑3 window extractor   (30 × 17 numeric matrix)
─────────────────────────────────────────────────────*/
const BUCKET = {        // bucket slices generated during Phase‑3 prep
  NASDAQ: "NASDAQ.csv",
  NYSE:   "NYSE.csv",
  TSX:    "TSX.csv"
};

/**
 * @param {string} symbol  e.g. "AAPL"
 * @param {Array|object} symbolsList – the same array you use in server.js
 * @return {Promise<number[][]>}  shape [30,17]
 */
async function getWindowFromBucket(symbol, symbolsList = []) {
  /* find exchange first */
  const entry = symbolsList.find((s) => (s.symbol || s) === symbol);
  if (!entry) throw new Error(`exchange not found for ${symbol}`);

  const bucketFile = path.join(__dirname, "data", BUCKET[entry.exchange || entry.ex]);
  if (!fs.existsSync(bucketFile))
    throw new Error(`${bucketFile} missing – run your Phase‑3 slice script first`);

  const rows = [];
  await new Promise((resolve) => {
    readline
      .createInterface({ input: fs.createReadStream(bucketFile) })
      .on("line", (ln) => {
        if (ln.startsWith(symbol + ",")) {
          rows.push(ln.split(","));
          if (rows.length > LOOKBACK) rows.shift(); // sliding window keep last 30
        }
      })
      .on("close", resolve);
  });

  if (rows.length < LOOKBACK) throw new Error("not enough history for window");

  /* project numeric 17‑column feature vector (skip symbol,date → +2 offset) */
  return rows.map((r) =>
    FORECAST_FEATURE_KEYS.map((_, i) => +r[i + 2] || 0)
  );
}

/*─────────────────────────────────────────────────────
  4) Simple helpers
─────────────────────────────────────────────────────*/
function getCachedHistoricalData(symbol) {
  return historicalDataCache[symbol] || [];
}

function storeInMemoryData(symbol, rows) {
  historicalDataCache[symbol] = rows;
}

/*─────────────────────────────────────────────────────
  5) Yahoo fall‑back fetchers (optional)
─────────────────────────────────────────────────────*/
async function fetchHistoricalData(symbol, yearsBack = 1) {
  const now   = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - yearsBack);
  try {
    return await yahooFinance.historical(symbol, {
      period1: start,
      period2: now,
      interval: "1d"
    });
  } catch (err) {
    console.error(`❌ yahooHistorical ${symbol}:`, err.message);
    return [];
  }
}

async function fetchAllSymbolsHistoricalData(symbols, yearsBack = 1) {
  for (const s of symbols) {
    const sym = typeof s === "string" ? s : s.symbol;
    const raw = await fetchHistoricalData(sym, yearsBack);
    if (!raw.length) continue;

    const shaped = raw.map((d) => {
      const out = { date: d.date.toISOString().slice(0, 10) };
      FORECAST_FEATURE_KEYS.forEach((k) => (out[k] = 0));
      out.open   = d.open   ?? 0;
      out.high   = d.high   ?? 0;
      out.low    = d.low    ?? 0;
      out.close  = d.close  ?? 0;
      out.volume = d.volume ?? 0;
      return out;
    });
    shaped.sort((a, b) => new Date(a.date) - new Date(b.date));
    storeInMemoryData(sym, shaped);
  }
}

/*─────────────────────────────────────────────────────
  6) Exports
─────────────────────────────────────────────────────*/
module.exports = {
  /* caching / CSV */
  loadCsvIntoMemory,
  getCachedHistoricalData,
  storeInMemoryData,

  /* Phase‑3 helpers */
  getWindowFromBucket,
  FORECAST_FEATURE_KEYS,

  /* Yahoo fall‑backs */
  fetchHistoricalData,
  fetchAllSymbolsHistoricalData
};

/*─────────────────────────────────────────────────────
  7) Stand‑alone sanity test
─────────────────────────────────────────────────────*/
if (require.main === module) {
  (async () => {
    try {
      loadCsvIntoMemory();
      const symbolsList = JSON.parse(
        fs.readFileSync(path.join(__dirname, "symbols.json"), "utf8")
      );
      const sample = await getWindowFromBucket("AAPL", symbolsList);
      console.log("Sample AAPL window shape:", sample.length, "×", sample[0].length);
    } catch (e) {
      console.error("✘", e.message);
    }
  })();
}

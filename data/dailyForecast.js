/**
 * dailyForecast.js
 *
 * For each symbol in historicalData.csv take the last 30 days of
 * 16 features and predict the next trading-day close with the
 * already-trained GRU model.
 *
 * Usage:  cd backend/data && node dailyForecast.js
 */

const fs   = require("fs");
const path = require("path");
const csv  = require("csv-parser");
const tf   = require("@tensorflow/tfjs-node");

// ────────────────────────────────────────────────────────────
// Constants – must match what you used for training
// ────────────────────────────────────────────────────────────
const FEATURE_KEYS = [
    // 13 market / fundamental
    "open","high","low","close","volume",
    "peRatio","earningsGrowth","debtToEquity",
    "revenue","netIncome","SMA20","RSI14","MACD",
    // 5 news-event signals
    "dailySentiment","tariffEvent","earningsEvent",
    "mergerEvent","regulationEvent"
  ];            // 18 columns
  
const TIME_SERIES_WINDOW = 30;

// paths
const HIST_CSV_PATH = path.join(__dirname, "historicalData.csv");
const OUT_CSV_PATH  = path.join(__dirname, "dailyForecasts.csv");
const MODEL_PATH    = "file://" + path.join(__dirname, "..", "model", "forecast_model", "model.json");
const NORM_PATH     = path.join(__dirname, "..", "model", "forecast_model", "normalization.json");

// ────────────────────────────────────────────────────────────
// Globals that we’ll fill in loadResources()
// ────────────────────────────────────────────────────────────
let model       = null;
let normParams  = null;

// load model + normalization once
async function loadResources() {
  if (!model) {
    console.log("📦 Loading GRU model …");
    model = await tf.loadLayersModel(MODEL_PATH);
    console.log("✅ Model loaded");
  }
  if (!normParams) {
    normParams = JSON.parse(fs.readFileSync(NORM_PATH, "utf8"));
    console.log("✅ Normalization parameters loaded");
  }
}

// helper: run model and return **normalized** prediction
function predictNextDay(sequence) {
  // sequence is 30×16 JS array (already normalized)
  const tensor = tf.tensor3d([sequence], [1, TIME_SERIES_WINDOW, FEATURE_KEYS.length]);
  const out    = model.predict(tensor);
  return out.dataSync()[0];          // still **normalized**
}

// helper: undo normalization for the close price
function deNormalizeClose(normVal) {
  const { mean = 0, std = 1 } = normParams.close || {};
  return normVal * std + mean;
}

// next trading date (skip weekend)
function nextTradingDateISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────
(async function main() {
  await loadResources();

  // 1  read historicalData.csv
  const rows = [];
  await new Promise(res =>
    fs.createReadStream(HIST_CSV_PATH)
      .pipe(csv())
      .on("data", r => rows.push(r))
      .on("end", res)
  );
  console.log(`📖 Loaded ${rows.length} rows from historicalData.csv`);

  // 2  group by symbol
  const bySym = {};
  rows.forEach(r => {
    (bySym[r.symbol] ||= []).push(r);
  });
  Object.values(bySym).forEach(arr =>
    arr.sort((a, b) => new Date(a.date) - new Date(b.date))
  );

  const tomorrowISO = nextTradingDateISO();
  const outLines = ["symbol,currentClose,forecastClose,forecastDate"];

  // 3  iterate
  for (const sym of Object.keys(bySym)) {
    const hist = bySym[sym];
    if (hist.length < TIME_SERIES_WINDOW) continue;

    const win   = hist.slice(-TIME_SERIES_WINDOW);
    const closeToday = parseFloat(win[TIME_SERIES_WINDOW - 1].close);

    // build normalized sequence
    const seq = win.map(r =>
      FEATURE_KEYS.map(feat => {
        const raw = parseFloat(r[feat]) || 0;
        const { mean = 0, std = 1 } = normParams[feat] || {};
        return std ? (raw - mean) / std : 0;
      })
    );

    let forecastClose;
    try {
      const normPred = predictNextDay(seq);
      forecastClose  = deNormalizeClose(normPred);
    } catch (err) {
      console.warn(`⚠️  Prediction error for ${sym}: ${err.message}`);
      continue;
    }

    outLines.push(
      [sym, closeToday.toFixed(2), forecastClose.toFixed(2), tomorrowISO].join(",")
    );
  }

  // 4  write CSV
  fs.writeFileSync(OUT_CSV_PATH, outLines.join("\n"), "utf8");
  console.log(`✅ Wrote ${OUT_CSV_PATH} (${outLines.length - 1} symbols)`);
})().catch(err => {
  console.error("❌ dailyForecast.js failed:", err);
  process.exit(1);
});

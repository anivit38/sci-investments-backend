/**
 * backtestGRU.js
 *
 * A symbol‑by‑symbol back‑test to avoid zero/NaN issues.
 *
 * Usage (from sci‑investments/backend/data):
 *   node backtestGRU.js
 */

const fs   = require("fs");
const path = require("path");
const csv  = require("csv-parser");
const { predictNextDay } = require("./trainGRU");

// The 13 features in your GRU
const FEATURES = [
  "open","high","low","close","volume",
  "peRatio","earningsGrowth","debtToEquity",
  "revenue","netIncome","SMA20","RSI14","MACD"
];

(async () => {
  console.log("👉 backtest starting…");
  const WINDOW = 30;
  const rows   = [];

  // 1) Load CSV
  await new Promise((resolve) => {
    fs.createReadStream(path.join(__dirname, "historicalData.csv"))
      .pipe(csv())
      .on("data", (r) => rows.push(r))
      .on("end", resolve);
  });
  console.log(`✔️  Loaded ${rows.length} rows`);

  // 2) Group rows by symbol
  const bySymbol = rows.reduce((acc, r) => {
    acc[r.symbol] = acc[r.symbol] || [];
    acc[r.symbol].push(r);
    return acc;
  }, {});

  // 3) Load normalization stats once
  const stats = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "model", "forecast_model", "normalization.json"),
      "utf-8"
    )
  );

  const results = [];

  // 4) For each symbol, sort by date & slide window
  for (const [symbol, data] of Object.entries(bySymbol)) {
    data.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (data.length < WINDOW + 1) continue;

    for (let i = WINDOW; i < data.length - 1; i++) {
      const today  = parseFloat(data[i].close);
      const actual = parseFloat(data[i + 1].close);
      if (!today || !actual) continue;

      // Build normalized window
      const windowArr = data
        .slice(i - WINDOW, i)
        .map((r) => {
          const raw = FEATURES.map((k) => parseFloat(r[k]) || 0);
          return raw.map((v, idx) => {
            const { mean = 0, std = 1 } = stats[FEATURES[idx]] || {};
            return std ? (v - mean) / std : 0;
          });
        });

      const pred = await predictNextDay(windowArr);
      results.push({ today, pred, actual });
    }
  }

  // 5) Compute metrics
  const N = results.length;
  const mape = results.reduce(
    (s, { pred, actual }) => s + Math.abs((pred - actual) / actual),
    0
  ) / N * 100;

  const dirAcc =
    results.filter(({ today, pred, actual }) =>
      Math.sign(pred - today) === Math.sign(actual - today)
    ).length / N * 100;

  // 6) Report
  console.table({
    Samples:     N,
    "MAPE (%)":  mape.toFixed(2),
    "DirAcc (%)": dirAcc.toFixed(2),
  });

  process.exit(0);
})();

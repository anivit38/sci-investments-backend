/**
 * backtestGRU.js
 *
 * A symbol‑by‑symbol back‑test to avoid zero/NaN issues.
 * Also writes out data/dailyForecasts.csv for downstream accuracy tracking.
 *
 * Usage (from sci‑investments/backend/data):
 *   node backtestGRU.js
 */

const fs      = require("fs");
const path    = require("path");
const csv     = require("csv-parser");
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

  // 1) Load your historicalData.csv
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
      "utf8"
    )
  );

  const results = [];
  const daily   = []; // <-- for dailyForecasts.csv

  // 4) For each symbol, sort by date & slide window
  for (const [symbol, data] of Object.entries(bySymbol)) {
    data.sort((a, b) => new Date(a.date) - new Date(b.date));
    if (data.length < WINDOW + 1) continue;

    for (let i = WINDOW; i < data.length - 1; i++) {
      const prevClose = parseFloat(data[i].close);
      const actual    = parseFloat(data[i + 1].close);
      if (!prevClose || !actual) continue;

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

      // predictNextDay returns a Number
      const pred = await predictNextDay(windowArr);

      // collect for metrics
      results.push({ prevClose, pred, actual });

      // collect for dailyForecasts.csv
      daily.push({
        date:           data[i].date,       // e.g. "2025-04-21"
        symbol,
        yesterdayClose: prevClose.toFixed(2),
        predictedClose: pred.toFixed(2),
        actualClose:    actual.toFixed(2)
      });
    }
  }

  // ─── write dailyForecasts.csv ─────────────────────────────────
  const outPath = path.join(__dirname, "dailyForecasts.csv");
  const header  = "date,symbol,yesterdayClose,predictedClose,actualClose";
  const lines   = [
    header,
    ...daily.map(r =>
      [r.date, r.symbol, r.yesterdayClose, r.predictedClose, r.actualClose].join(",")
    )
  ].join("\n");
  fs.writeFileSync(outPath, lines, "utf8");
  console.log(`→ Wrote dailyForecasts.csv (${daily.length} rows)`);

  // ─── compute in‐script MAPE & DirAcc ─────────────────────────
  const N     = results.length;
  const mape  = results.reduce(
    (sum, { pred, actual }) => sum + Math.abs((pred - actual) / actual),
    0
  ) / N * 100;
  const dirOK = results.filter(
    ({ prevClose, pred, actual }) =>
      Math.sign(pred - prevClose) === Math.sign(actual - prevClose)
  ).length;
  const dirAcc = dirOK / N * 100;

  console.table({
    Samples:      N,
    "MAPE (%)":   mape.toFixed(2),
    "DirAcc (%)": dirAcc.toFixed(2)
  });

  process.exit(0);
})();

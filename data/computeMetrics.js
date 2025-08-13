// backend/data/computeMetrics.js
const fs   = require("fs");
const csv  = require("csv-parser");
const path = require("path");

const IN_CSV  = path.join(__dirname, "dailyForecasts.csv");
const OUT_CSV = path.join(__dirname, "dailyMetrics.csv");

if (!fs.existsSync(IN_CSV)) {
  console.error("❌ dailyForecasts.csv not found. Run backtestGRU first.");
  process.exit(1);
}

const rows = [];
fs.createReadStream(IN_CSV)
  .pipe(csv())
  .on("data", (r) => rows.push(r))
  .on("end", () => {
    if (rows.length === 0) {
      console.error("No rows in dailyForecasts.csv");
      process.exit(1);
    }

    let sumPct = 0;
    let dirOK  = 0;
    for (const r of rows) {
      const prev    = parseFloat(r.yesterdayClose);
      const pred    = parseFloat(r.predictedClose);
      const actual  = parseFloat(r.actualClose);
      // 1) absolute % error
      const errPct = Math.abs((actual - pred) / actual) * 100;
      sumPct += errPct;
      // 2) direction correct?
      if ((actual - prev) * (pred - prev) >= 0) dirOK++;
    }

    const N        = rows.length;
    const MAPE     = sumPct / N;
    const DirAcc   = (dirOK / N) * 100;
    const today    = new Date().toISOString().slice(0,10);

    console.log(`📊 ${today}  MAPE: ${MAPE.toFixed(2)}%   DirAcc: ${DirAcc.toFixed(2)}%`);

    // append to dailyMetrics.csv
    const header = !fs.existsSync(OUT_CSV);
    const line   = `${today},${MAPE.toFixed(2)},${DirAcc.toFixed(2)}\n`;
    fs.appendFileSync(OUT_CSV, (header ? "date,MAPE,DirAcc\n" : "") + line);
    console.log(`→ Appended to ${OUT_CSV}`);
  });

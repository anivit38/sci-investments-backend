/**
 * trainGRU.js
 *
 * Loads data/historicalData.csv (with your 18 columns: 13 price/fundamental +
 * 5 news features), normalizes each feature, creates 30‑day sequences,
 * trains a 2‑layer GRU with early stopping, and writes model + normalization.json.
 */

const fs = require("fs");
const path = require("path");
const tf = require("@tensorflow/tfjs-node");

const CSV_PATH = path.join(__dirname, "historicalData.csv");
const MODEL_DIR = path.join(__dirname, "..", "model", "forecast_model");
const NORM_PATH = path.join(MODEL_DIR, "normalization.json");
const WINDOW_SIZE = 30;
const TEST_SPLIT = 0.2;

// 1) Read & parse CSV
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, "utf8");
  const lines = raw.trim().split("\n");
  const header = lines[0].split(",");
  const rows = lines.slice(1).map(line => {
    const parts = line.split(",");
    const obj = {};
    header.forEach((col, i) => {
      obj[col] = parseFloat(parts[i]);
    });
    return obj;
  });
  return { header, rows };
}

// 2) Compute mean/std for each feature column
function computeStats(rows, numericCols) {
  const stats = {};
  numericCols.forEach(col => {
    const vals = rows.map(r => r[col]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
    stats[col] = { mean, std: std || 1 };
  });
  return stats;
}

// 3) Normalize rows
function normalizeRows(rows, stats, numericCols) {
  return rows.map(r => {
    const norm = {};
    numericCols.forEach(col => {
      norm[col] = (r[col] - stats[col].mean) / stats[col].std;
    });
    return norm;
  });
}

// 4) Create sequences of shape [n‑samples, WINDOW_SIZE, nFeatures] and labels
function createSequences(data, numericCols) {
  const X = [];
  const Y = [];
  for (let i = 0; i + WINDOW_SIZE < data.length; i++) {
    const seq = [];
    for (let j = 0; j < WINDOW_SIZE; j++) {
      seq.push(numericCols.map(col => data[i + j][col]));
    }
    X.push(seq);
    // predict next-day close (we assume 'close' is in numericCols)
    Y.push([ data[i + WINDOW_SIZE]["close"] ]);
  }
  return { X, Y };
}

async function main() {
  console.log("📖 Loading CSV...");
  const { header, rows: rawRows } = parseCSV(CSV_PATH);

  // Identify numeric columns (everything except 'symbol'/'date', which we dropped)
  const numericCols = header.filter(c => c !== "symbol" && c !== "date");
  console.log("ℹ️  Numeric features:", numericCols);

  if (rawRows.length < WINDOW_SIZE * 2) {
    throw new Error("Not enough rows for training!");
  }

  console.log("⚖️  Computing normalization stats...");
  const stats = computeStats(rawRows, numericCols);

  console.log("🔄 Normalizing data...");
  const normRows = normalizeRows(rawRows, stats, numericCols);

  console.log(`🔢 Creating sequences (window=${WINDOW_SIZE})...`);
  const { X, Y } = createSequences(normRows, numericCols);

  const total = X.length;
  const testCount = Math.floor(total * TEST_SPLIT);
  const trainCount = total - testCount;

  console.log(`🏷️  Train/test split: ${trainCount}/${testCount} samples`);

  const Xtensor = tf.tensor3d(X);
  const Ytensor = tf.tensor2d(Y);

  const Xtrain = Xtensor.slice([0, 0, 0], [trainCount, WINDOW_SIZE, numericCols.length]);
  const Ytrain = Ytensor.slice([0, 0], [trainCount, 1]);
  const Xtest  = Xtensor.slice([trainCount, 0, 0], [testCount, WINDOW_SIZE, numericCols.length]);
  const Ytest  = Ytensor.slice([trainCount, 0], [testCount, 1]);

  // 5) Build the model
  console.log("🛠️  Building model...");
  const model = tf.sequential();
  model.add(tf.layers.gru({
    units: 64,
    returnSequences: true,
    inputShape: [WINDOW_SIZE, numericCols.length]
  }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.gru({ units: 32 }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.dense({ units: 1 }));

  model.compile({
    optimizer: tf.train.adam(),
    loss: "meanSquaredError",
    metrics: ["mse"]
  });

  model.summary();

  // 6) Train with early stopping
  console.log("🏋️  Starting training...");
  const esCallback = tf.callbacks.earlyStopping({
    monitor: "val_loss",
    patience: 5,
    restoreBestWeight: true
  });

  await model.fit(Xtrain, Ytrain, {
    epochs: 50,
    batchSize: 32,
    validationData: [Xtest, Ytest],
    callbacks: [esCallback]
  });

  // 7) Evaluate
  console.log("🔍 Evaluating on test set...");
  const evalResult = model.evaluate(Xtest, Ytest);
  console.log("Test MSE:", (await evalResult[0].data())[0].toFixed(6));

  // 8) Save model & stats
  console.log("💾 Saving model to", MODEL_DIR);
  await model.save(`file://${MODEL_DIR}`);

  if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR, { recursive: true });
  fs.writeFileSync(NORM_PATH, JSON.stringify(stats, null, 2), "utf8");
  console.log("✅ Saved normalization stats to", NORM_PATH);
}

main().catch(err => {
  console.error("❌ Error in training script:", err);
  process.exit(1);
});

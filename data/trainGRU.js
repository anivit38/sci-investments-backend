/**
 * trainGRU.js
 *
 * This script:
 * 1. Loads a CSV with columns:
 *    symbol,date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity,
 *    revenue,netIncome,SMA20,RSI14,MACD
 * 2. Computes mean/std for each numeric feature for normalization.
 * 3. Normalizes the data.
 * 4. Creates sequences (window of 30 days) to predict next day's close.
 * 5. Builds and trains a GRU model.
 * 6. Saves the trained model + normalization.json
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const tf = require("@tensorflow/tfjs-node");

/******************************************************
 * 1) LOAD & PARSE THE CSV
 ******************************************************/
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, "utf-8");
  const lines = raw.trim().split("\n");
  // Expect at least 15 columns:
  //   symbol, date, open, high, low, close, volume,
  //   peRatio, earningsGrowth, debtToEquity,
  //   revenue, netIncome, SMA20, RSI14, MACD
  const header = lines[0].split(",");
  if (header.length < 15) {
    throw new Error("CSV must have at least 15 columns.");
  }
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 15) continue;
    // We'll skip symbol/date for training, focusing on numeric features:
    data.push({
      open: parseFloat(cols[2]),
      high: parseFloat(cols[3]),
      low: parseFloat(cols[4]),
      close: parseFloat(cols[5]),
      volume: parseFloat(cols[6]),
      peRatio: parseFloat(cols[7]),
      earningsGrowth: parseFloat(cols[8]),
      debtToEquity: parseFloat(cols[9]),
      revenue: parseFloat(cols[10]),
      netIncome: parseFloat(cols[11]),
      SMA20: parseFloat(cols[12]),
      RSI14: parseFloat(cols[13]),
      MACD: parseFloat(cols[14]),
    });
  }
  return data;
}

/******************************************************
 * 2) COMPUTE MEAN & STD FOR NORMALIZATION
 ******************************************************/
function computeMeanStd(array) {
  const mean = array.reduce((a, b) => a + b, 0) / array.length;
  const variance = array.reduce((acc, val) => acc + (val - mean) ** 2, 0) / array.length;
  const std = Math.sqrt(variance);
  return { mean, std };
}

/******************************************************
 * 3) NORMALIZE THE DATA
 ******************************************************/
function normalizeData(data, stats) {
  return data.map(row => ({
    open: (row.open - stats.open.mean) / stats.open.std,
    high: (row.high - stats.high.mean) / stats.high.std,
    low: (row.low - stats.low.mean) / stats.low.std,
    close: (row.close - stats.close.mean) / stats.close.std,
    volume: (row.volume - stats.volume.mean) / stats.volume.std,
    peRatio: (row.peRatio - stats.peRatio.mean) / stats.peRatio.std,
    earningsGrowth: (row.earningsGrowth - stats.earningsGrowth.mean) / stats.earningsGrowth.std,
    debtToEquity: (row.debtToEquity - stats.debtToEquity.mean) / stats.debtToEquity.std,
    revenue: (row.revenue - stats.revenue.mean) / stats.revenue.std,
    netIncome: (row.netIncome - stats.netIncome.mean) / stats.netIncome.std,
    SMA20: (row.SMA20 - stats.SMA20.mean) / stats.SMA20.std,
    RSI14: (row.RSI14 - stats.RSI14.mean) / stats.RSI14.std,
    MACD: (row.MACD - stats.MACD.mean) / stats.MACD.std,
  }));
}

/******************************************************
 * 4) CREATE SEQUENCES FOR TIME-SERIES
 ******************************************************/
function createSequences(data, windowSize = 30) {
  const X = [];
  const Y = [];
  for (let i = 0; i < data.length - windowSize; i++) {
    const window = data.slice(i, i + windowSize);
    const next = data[i + windowSize];
    // 13 features
    const seq = window.map(d => [
      d.open, d.high, d.low, d.close, d.volume,
      d.peRatio, d.earningsGrowth, d.debtToEquity,
      d.revenue, d.netIncome, d.SMA20, d.RSI14, d.MACD
    ]);
    X.push(seq);
    Y.push([ next.close ]); // predict next day's close
  }
  return { X, Y };
}

/******************************************************
 * 5) MAIN: LOAD, NORMALIZE, BUILD, TRAIN
 ******************************************************/
async function main() {
  const csvPath = path.join(__dirname, "historicalData.csv");
  console.log("Reading CSV from:", csvPath);

  const rawData = parseCSV(csvPath);
  if (rawData.length < 50) {
    console.log("Not enough rows in CSV for training!");
    return;
  }

  // Compute stats for each feature
  const stats = {
    open: computeMeanStd(rawData.map(d => d.open)),
    high: computeMeanStd(rawData.map(d => d.high)),
    low: computeMeanStd(rawData.map(d => d.low)),
    close: computeMeanStd(rawData.map(d => d.close)),
    volume: computeMeanStd(rawData.map(d => d.volume)),
    peRatio: computeMeanStd(rawData.map(d => d.peRatio)),
    earningsGrowth: computeMeanStd(rawData.map(d => d.earningsGrowth)),
    debtToEquity: computeMeanStd(rawData.map(d => d.debtToEquity)),
    revenue: computeMeanStd(rawData.map(d => d.revenue)),
    netIncome: computeMeanStd(rawData.map(d => d.netIncome)),
    SMA20: computeMeanStd(rawData.map(d => d.SMA20)),
    RSI14: computeMeanStd(rawData.map(d => d.RSI14)),
    MACD: computeMeanStd(rawData.map(d => d.MACD)),
  };

  // Normalize
  const normalizedData = normalizeData(rawData, stats);

  // Create sequences (window=30)
  const windowSize = 30;
  const { X, Y } = createSequences(normalizedData, windowSize);
  console.log("Created sequences:", X.length);
  if (X.length < 2) {
    console.log("Not enough sequences for training!");
    return;
  }

  // Convert to Tensors
  const Xtensor = tf.tensor3d(X); // shape [samples, 30, 13]
  const Ytensor = tf.tensor2d(Y); // shape [samples, 1]

  // 80/20 split
  const splitIndex = Math.floor(Xtensor.shape[0] * 0.8);
  const Xtrain = Xtensor.slice([0, 0, 0], [splitIndex, windowSize, 13]);
  const Ytrain = Ytensor.slice([0, 0], [splitIndex, 1]);
  const Xtest = Xtensor.slice([splitIndex, 0, 0], [Xtensor.shape[0] - splitIndex, windowSize, 13]);
  const Ytest = Ytensor.slice([splitIndex, 0], [Ytensor.shape[0] - splitIndex, 1]);

  console.log("Train samples:", Xtrain.shape[0]);
  console.log("Test samples:", Xtest.shape[0]);

  // Build GRU model
  const model = tf.sequential();
  model.add(tf.layers.gru({
    units: 64,
    returnSequences: false,
    inputShape: [windowSize, 13],
  }));
  model.add(tf.layers.dense({ units: 1 }));

  model.compile({
    optimizer: tf.train.adam(),
    loss: "meanSquaredError",
  });

  model.summary();

  // Train
  const batchSize = 4;
  const epochs = 10;
  console.log("Starting training...");
  await model.fit(Xtrain, Ytrain, {
    batchSize,
    epochs,
    validationData: [Xtest, Ytest],
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        console.log(
          `Epoch ${epoch + 1}/${epochs} - loss: ${logs.loss.toFixed(6)}, val_loss: ${logs.val_loss.toFixed(6)}`
        );
      }
    }
  });

  // Evaluate
  const evalResult = model.evaluate(Xtest, Ytest);
  const testLoss = evalResult.dataSync()[0];
  console.log("Final test MSE:", testLoss);

  // Save model + normalization
  const outDir = path.join(__dirname, "../model/forecast_model");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  console.log("Saving model to:", outDir);
  await model.save(`file://${outDir}`);

  const normalizationData = {
    open: stats.open,
    high: stats.high,
    low: stats.low,
    close: stats.close,
    volume: stats.volume,
    peRatio: stats.peRatio,
    earningsGrowth: stats.earningsGrowth,
    debtToEquity: stats.debtToEquity,
    revenue: stats.revenue,
    netIncome: stats.netIncome,
    SMA20: stats.SMA20,
    RSI14: stats.RSI14,
    MACD: stats.MACD,
  };

  const normPath = path.join(outDir, "normalization.json");
  fs.writeFileSync(normPath, JSON.stringify(normalizationData, null, 2));
  console.log("Wrote normalization.json:", normPath);

  console.log("✅ Done training and saving model!");
}

main().catch(err => console.error(err));

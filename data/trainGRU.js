/**
 * trainGRU.js
 *
 * This script:
 * 1. Loads a CSV with columns:
 *    date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity
 * 2. Computes mean and standard deviation for each numeric feature.
 * 3. Normalizes the data.
 * 4. Creates time-series sequences (using a window of 30 days) to predict the next day's close.
 * 5. Builds and trains a GRU model.
 * 6. Saves the trained model and a normalization.json file.
 */

const fs = require("fs");
const path = require("path");
const tf = require("@tensorflow/tfjs-node");

/******************************************************
 * 1) LOAD & PARSE THE CSV
 ******************************************************/
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, "utf-8");
  const lines = raw.trim().split("\n");
  // Expect header: date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity
  const header = lines[0].split(",");
  if (header.length < 9) {
    throw new Error("CSV must have 9 columns: date,open,high,low,close,volume,peRatio,earningsGrowth,debtToEquity");
  }

  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 9) continue;

    const [
      date,
      open,
      high,
      low,
      close,
      volume,
      peRatio,
      earningsGrowth,
      debtToEquity,
    ] = cols;

    data.push({
      date,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
      peRatio: parseFloat(peRatio),
      earningsGrowth: parseFloat(earningsGrowth),
      debtToEquity: parseFloat(debtToEquity),
    });
  }
  return data;
}

/******************************************************
 * 2) COMPUTE MEAN & STD FOR NORMALIZATION
 ******************************************************/
function computeMeanStd(array) {
  const mean = array.reduce((a, b) => a + b, 0) / array.length;
  const variance = array.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / array.length;
  const std = Math.sqrt(variance);
  return { mean, std };
}

function normalize(value, mean, std) {
  if (Number.isNaN(value)) return 0;
  if (std === 0) return 0;
  return (value - mean) / std;
}

/******************************************************
 * 3) CREATE SEQUENCES FOR TIME-SERIES
 *    For each index i, input: data[i..i+windowSize-1],
 *    label: close at data[i+windowSize]
 ******************************************************/
function createSequences(data, windowSize = 30) {
  const X = [];
  const Y = [];

  for (let i = 0; i < data.length - windowSize; i++) {
    const window = data.slice(i, i + windowSize);
    const next = data[i + windowSize];

    // Each day: [open, high, low, close, volume, peRatio, earningsGrowth, debtToEquity]
    const seq = window.map(d => [
      d.open,
      d.high,
      d.low,
      d.close,
      d.volume,
      d.peRatio,
      d.earningsGrowth,
      d.debtToEquity
    ]);

    X.push(seq);
    Y.push([next.close]); // predicting the next day's close
  }

  return { X, Y };
}

/******************************************************
 * 4) MAIN: LOAD DATA, NORMALIZE, BUILD DATASET
 ******************************************************/
async function main() {
  const csvPath = path.join(__dirname, "historicalData_withFundamentals.csv");
  console.log("Reading CSV from:", csvPath);

  const rawData = parseCSV(csvPath);
  if (rawData.length < 50) {
    console.log("Not enough rows in CSV to train a model!");
    return;
  }

  // Compute mean/std for each feature from the raw data
  const opens = rawData.map(d => d.open);
  const highs = rawData.map(d => d.high);
  const lows = rawData.map(d => d.low);
  const closes = rawData.map(d => d.close);
  const volumes = rawData.map(d => d.volume);
  const peRatios = rawData.map(d => d.peRatio);
  const earningsGrowths = rawData.map(d => d.earningsGrowth);
  const debtToEquities = rawData.map(d => d.debtToEquity);

  const openStats = computeMeanStd(opens);
  const highStats = computeMeanStd(highs);
  const lowStats = computeMeanStd(lows);
  const closeStats = computeMeanStd(closes);
  const volumeStats = computeMeanStd(volumes);
  const peStats = computeMeanStd(peRatios);
  const egStats = computeMeanStd(earningsGrowths);
  const debtStats = computeMeanStd(debtToEquities);

  // Normalize the dataset
  const normalizedData = rawData.map(d => ({
    open: normalize(d.open, openStats.mean, openStats.std),
    high: normalize(d.high, highStats.mean, highStats.std),
    low: normalize(d.low, lowStats.mean, lowStats.std),
    close: normalize(d.close, closeStats.mean, closeStats.std),
    volume: normalize(d.volume, volumeStats.mean, volumeStats.std),
    peRatio: normalize(d.peRatio, peStats.mean, peStats.std),
    earningsGrowth: normalize(d.earningsGrowth, egStats.mean, egStats.std),
    debtToEquity: normalize(d.debtToEquity, debtStats.mean, debtStats.std),
  }));

  // Create time-series sequences with a 30-day window
  const windowSize = 30;
  const { X, Y } = createSequences(normalizedData, windowSize);
  console.log("Created sequences:", X.length);

  if (X.length < 2) {
    console.log("Not enough sequences for training!");
    return;
  }

  // Convert to Tensors: X shape [samples, windowSize, 8], Y shape [samples, 1]
  const Xtensor = tf.tensor3d(X);
  const Ytensor = tf.tensor2d(Y);

  // Split into training and testing sets (80/20 split)
  const splitIndex = Math.floor(Xtensor.shape[0] * 0.8);
  const Xtrain = Xtensor.slice([0, 0, 0], [splitIndex, windowSize, 8]);
  const Ytrain = Ytensor.slice([0, 0], [splitIndex, 1]);
  const Xtest = Xtensor.slice([splitIndex, 0, 0], [Xtensor.shape[0] - splitIndex, windowSize, 8]);
  const Ytest = Ytensor.slice([splitIndex, 0], [Ytensor.shape[0] - splitIndex, 1]);

  console.log("Train samples:", Xtrain.shape[0]);
  console.log("Test samples:", Xtest.shape[0]);

  /******************************************************
   * 5) BUILD THE GRU MODEL
   ******************************************************/
  const model = tf.sequential();
  model.add(tf.layers.gru({
    units: 64,
    returnSequences: false,
    inputShape: [windowSize, 8],
  }));
  model.add(tf.layers.dense({ units: 1 }));

  model.compile({
    optimizer: tf.train.adam(),
    loss: "meanSquaredError",
  });

  model.summary();

  /******************************************************
   * 6) TRAIN THE MODEL
   ******************************************************/
  const batchSize = 16;
  const epochs = 10;

  console.log("Starting training...");
  await model.fit(Xtrain, Ytrain, {
    batchSize,
    epochs,
    validationData: [Xtest, Ytest],
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        console.log(`Epoch ${epoch + 1}/${epochs} - loss: ${logs.loss.toFixed(6)}, val_loss: ${logs.val_loss.toFixed(6)}`);
      }
    }
  });

  // Evaluate final test MSE
  const evalResult = model.evaluate(Xtest, Ytest);
  const testLoss = evalResult.dataSync()[0];
  console.log("Final test MSE:", testLoss);

  /******************************************************
   * 7) SAVE THE MODEL AND NORMALIZATION PARAMETERS
   ******************************************************/
  const outDir = path.join(__dirname, "../model/forecast_model");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log(`Saving model to: ${outDir}`);
  await model.save(`file://${outDir}`);

  // Create normalization.json with the stats for each feature
  const normalizationData = {
    open: openStats,
    high: highStats,
    low: lowStats,
    close: closeStats,
    volume: volumeStats,
    peRatio: peStats,
    earningsGrowth: egStats,
    debtToEquity: debtStats,
  };

  const normPath = path.join(outDir, "normalization.json");
  fs.writeFileSync(normPath, JSON.stringify(normalizationData, null, 2));
  console.log("Wrote normalization.json:", normPath);

  console.log("✅ Done training and saving model!");
}

main().catch(err => console.error(err));

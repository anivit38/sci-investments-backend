// trainModel.js
const tf = require("@tensorflow/tfjs-node");
const fs = require("fs");

// Function to ensure a directory exists (creates it if necessary)
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function trainModel() {
  try {
    // Load the preprocessed data from preprocessedData.json
    const rawData = fs.readFileSync("preprocessedData.json");
    const data = JSON.parse(rawData);
    
    // Sort data by date (ascending)
    data.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Extract closing prices from the data
    const closingPrices = data.map(item => item.close);

    // Normalize the data using min-max scaling
    const minPrice = Math.min(...closingPrices);
    const maxPrice = Math.max(...closingPrices);
    const normalizedPrices = closingPrices.map(price => (price - minPrice) / (maxPrice - minPrice));

    // Define a sliding window size (e.g., 60 days)
    const windowSize = 60;
    const xs = [];
    const ys = [];

    // Create sequences: each input (X) is a sequence of 60 days, output (Y) is the next day's price.
    for (let i = 0; i < normalizedPrices.length - windowSize; i++) {
      xs.push(normalizedPrices.slice(i, i + windowSize));
      ys.push(normalizedPrices[i + windowSize]);
    }

    // Convert data to tensors.
    const xsTensor = tf.tensor2d(xs).reshape([xs.length, windowSize, 1]);
    const ysTensor = tf.tensor1d(ys);

    // Build a GRU model.
    const model = tf.sequential();
    model.add(tf.layers.gru({
      units: 50,
      inputShape: [windowSize, 1],
      returnSequences: false
    }));
    model.add(tf.layers.dense({ units: 1 }));

    // Compile the model.
    model.compile({
      optimizer: tf.train.adam(),
      loss: "meanSquaredError"
    });

    console.log("Model Summary:");
    model.summary();

    // Train the model.
    await model.fit(xsTensor, ysTensor, {
      epochs: 50,
      batchSize: 16,
      validationSplit: 0.1,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          console.log(`Epoch ${epoch + 1}: loss = ${logs.loss.toFixed(5)}`);
        }
      }
    });

    // Ensure the directory exists before saving the model.
    const modelDir = "model/forecast_model";
    ensureDir(modelDir);

    // Save the trained model to disk.
    await model.save("file://" + modelDir);
    console.log("Model saved to " + modelDir);

    // Save normalization parameters.
    const normalizationParams = { minPrice, maxPrice };
    fs.writeFileSync(
      modelDir + "/normalization.json",
      JSON.stringify(normalizationParams, null, 2)
    );
    console.log("Normalization parameters saved to " + modelDir + "/normalization.json");

    // Dispose tensors.
    xsTensor.dispose();
    ysTensor.dispose();
  } catch (error) {
    console.error("Error training model:", error);
  }
}

trainModel();

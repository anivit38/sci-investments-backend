// updateExtendedMetrics.js
require("dotenv").config();
const axios = require("axios");
const mongoose = require("mongoose");
const path = require("path");

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sci_investments";
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("✅ Connected to MongoDB for extended metrics"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err.message));

// Define a schema for extended metrics
const extendedMetricsSchema = new mongoose.Schema({
  symbol: { type: String, unique: true, required: true },
  revenueGrowth: Number,
  freeCashFlow: Number,
  // add more fields as needed...
  lastUpdated: { type: Date, default: Date.now },
});

const ExtendedMetrics = mongoose.model("ExtendedMetrics", extendedMetricsSchema);

// Function to fetch extended metrics for a given stock symbol
async function fetchExtendedMetrics(symbol) {
  const apiKey = process.env.FMP_API_KEY; // Get your free API key from FMP
  try {
    // Example endpoint: Income Statement for revenue data
    const incomeResponse = await axios.get(
      `https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=1&apikey=${apiKey}`
    );
    // Example endpoint: Cash Flow Statement for free cash flow
    const cashFlowResponse = await axios.get(
      `https://financialmodelingprep.com/api/v3/cash-flow-statement/${symbol}?limit=1&apikey=${apiKey}`
    );

    // Parse responses (you might need to adjust based on the actual API response structure)
    const incomeData = incomeResponse.data[0] || {};
    const cashFlowData = cashFlowResponse.data[0] || {};

    return {
      symbol,
      revenueGrowth: incomeData.revenueGrowth ? parseFloat(incomeData.revenueGrowth) : null,
      freeCashFlow: cashFlowData.freeCashFlow ? parseFloat(cashFlowData.freeCashFlow) : null,
      lastUpdated: new Date(),
    };
  } catch (err) {
    console.error(`Error fetching extended metrics for ${symbol}:`, err.message);
    return null;
  }
}

// Main update function: update metrics for a list of symbols
async function updateExtendedMetrics() {
  // Read symbols from your symbols.json file
  const symbolsPath = path.join(__dirname, "../symbols.json");
  let symbols = [];
  try {
    const rawData = require(symbolsPath);
    symbols = rawData.map((item) =>
      typeof item === "string" ? item : item.symbol
    );
  } catch (err) {
    console.error("Error reading symbols.json:", err.message);
    return;
  }

  for (const symbol of symbols) {
    const metrics = await fetchExtendedMetrics(symbol);
    if (!metrics) continue;
    try {
      // Upsert the extended metrics for the symbol
      await ExtendedMetrics.findOneAndUpdate(
        { symbol: metrics.symbol },
        metrics,
        { upsert: true, new: true }
      );
      console.log(`Updated extended metrics for ${metrics.symbol}`);
    } catch (err) {
      console.error(`Error updating extended metrics for ${symbol}:`, err.message);
    }
  }
  console.log("✅ Extended metrics update complete!");
  mongoose.disconnect();
}

// Run the update when this module is executed directly
if (require.main === module) {
  updateExtendedMetrics();
}

module.exports = { updateExtendedMetrics };

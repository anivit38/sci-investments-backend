const express = require("express");
const cors = require("cors");
const yahooFinance = require("yahoo-finance2").default;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Health check route (important for Render)
app.get("/", (req, res) => {
  res.send("✅ Stock Checker API is running!");
});

app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent, avgVolume } = req.body;

  if (!symbol || !intent || typeof avgVolume !== "number") {
    return res.status(400).json({ message: "Stock symbol, intent (buy/sell), and avgVolume (number) are required." });
  }

  try {
    const stock = await yahooFinance.quoteSummary(symbol, {
      modules: ["financialData", "price", "summaryDetail", "defaultKeyStatistics"],
    });

    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }

    const metrics = {
      volume: stock.price?.regularMarketVolume ?? 0,
      currentPrice: stock.price?.regularMarketPrice ?? 0,
      peRatio: stock.summaryDetail?.trailingPE ?? 0,
      pbRatio: stock.summaryDetail?.priceToBook ?? 0,
      dividendYield: stock.summaryDetail?.dividendYield ?? 0,
      earningsGrowth: stock.financialData?.earningsGrowth ?? 0,
      debtRatio: stock.financialData?.debtToEquity ?? 0,
      avg50Days: stock.price?.fiftyDayAverage ?? 0,
      avg200Days: stock.price?.twoHundredDayAverage ?? 0,
    };

    let stockRating = 0;

    // Perform analysis
    if (metrics.volume > avgVolume * 1.1) stockRating += 2;
    else if (metrics.volume < avgVolume * 0.9) stockRating -= 2;

    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) stockRating += 2;
    else if (metrics.peRatio > 20) stockRating -= 1;

    if (metrics.pbRatio < 1) stockRating += 2;
    else if (metrics.pbRatio > 3) stockRating -= 2;

    if (metrics.dividendYield > 0.05) stockRating += 2;
    if (metrics.earningsGrowth > 0.05) stockRating += 2;

    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) stockRating += 2;
    else if (metrics.debtRatio > 0.7) stockRating -= 2;

    if (metrics.currentPrice > metrics.avg50Days && metrics.avg50Days > metrics.avg200Days) stockRating += 2;
    else if (metrics.currentPrice < metrics.avg50Days && metrics.avg50Days < metrics.avg200Days) stockRating -= 2;

    // Determine advice
    let advice;
    if (intent === "buy") {
      if (stockRating >= 25) advice = "Very Good Stock to Buy";
      else if (stockRating >= 15) advice = "Good Stock to Buy";
      else if (stockRating >= 5) advice = "Okay Stock to Buy";
      else if (stockRating >= -5) advice = "Neutral Stock";
      else advice = "Bad Stock to Buy";
    } else if (intent === "sell") {
      advice = stockRating < 0 ? "Sell the Stock" : "Hold the Stock";
    }

    res.json({ symbol, stockRating, advice, metrics });
  } catch (error) {
    console.error("❌ Error fetching stock data:", error);
    res.status(500).json({ message: "Error fetching stock data.", error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Stock Checker API running on http://localhost:${PORT}`);
});

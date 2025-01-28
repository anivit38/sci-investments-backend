const express = require("express");
const cors = require("cors");
const yahooFinance = require("yahoo-finance2").default;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});

app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent, avgVolume } = req.body;

  if (!symbol || !intent) {
    return res.status(400).json({ message: "Stock symbol and intent (buy/sell) are required." });
  }

  try {
    const stock = await yahooFinance.quoteSummary(symbol, {
      modules: ["financialData", "price", "summaryDetail", "defaultKeyStatistics"],
    });

    if (!stock) {
      return res.status(404).json({ message: "Stock not found." });
    }

    const metrics = {
      volume: stock.price?.regularMarketVolume,
      currentPrice: stock.price?.regularMarketPrice,
      peRatio: stock.summaryDetail?.trailingPE,
      pbRatio: stock.summaryDetail?.priceToBook,
      dividendYield: stock.summaryDetail?.dividendYield,
      earningsGrowth: stock.financialData?.earningsGrowth,
      debtRatio: stock.financialData?.debtToEquity,
      avg50Days: stock.price?.fiftyDayAverage,
      avg200Days: stock.price?.twoHundredDayAverage,
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
    console.error("Error fetching stock data:", error.message);
    res.status(500).json({ message: "Error fetching stock data." });
  }
});

app.listen(PORT, () => {
  console.log(`Stock Checker server running on http://localhost:${PORT}`);
});

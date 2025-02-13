/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, AND FORECASTING
 *******************************************/

// 1. Load Environment & Libraries
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const tf = require("@tensorflow/tfjs-node");

// Helper: Delay (in milliseconds)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Custom request options to allow following Yahoo Finance redirects
const requestOptions = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36",
  },
  redirect: "follow", // <-- changed from "manual" to "follow"
};

// 2. Models & External APIs
const UserModel = require(path.join(__dirname, "models", "User"));
const yahooFinance = require("yahoo-finance2").default;

// 2.1 Load industry metrics from JSON
let industryMetrics = {};
try {
  industryMetrics = require("./industryMetrics.json");
} catch (err) {
  console.error("Error loading industryMetrics.json:", err.message);
}

// 3. Create Express App
const app = express();
app.use(cors());
app.use(bodyParser.json());

// 4. Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sci_investments";
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err.message));
mongoose.set("debug", true);

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";

// --- Forecast Model Resources ---
let forecastModel = null;
let normalizationParams = null;

async function loadForecastResources() {
  try {
    forecastModel = await tf.loadLayersModel("file://model/forecast_model/model.json");
    console.log("✅ Forecast model loaded successfully.");

    const normPath = path.join(__dirname, "model", "forecast_model", "normalization.json");
    const normData = fs.readFileSync(normPath);
    normalizationParams = JSON.parse(normData);

    console.log("✅ Normalization parameters loaded:", normalizationParams);
  } catch (error) {
    console.error("❌ Error loading forecast resources:", error.message);
  }
}
loadForecastResources();

/******************************************************
 * SECTION A: Auth Endpoints
 ******************************************************/
app.get("/", (req, res) => {
  res.send("✅ Combined Server is running!");
});

app.post("/signup", async (req, res) => {
  console.log("📩 Signup Request Received:", req.body);
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ message: "All fields are required." });
  }
  try {
    const existingUser = await UserModel.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use." });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new UserModel({ email, username, password: hashedPassword });
    await user.save();
    console.log("✅ User Registered:", username);
    return res.status(201).json({ message: "User registered successfully." });
  } catch (error) {
    console.error("❌ Signup Error:", error.message);
    return res.status(500).json({ message: "Error during signup." });
  }
});

app.post("/login", async (req, res) => {
  console.log("🔑 Login Attempt:", req.body.username);
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required." });
  }
  try {
    const user = await UserModel.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, {
      expiresIn: "24h",
    });
    console.log("✅ Login Successful:", username);
    return res.status(200).json({ message: "Login successful.", token });
  } catch (error) {
    console.error("❌ Login Error:", error.message);
    return res.status(500).json({ message: "Error during login." });
  }
});

app.get("/protected", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Unauthorized. Token required." });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.status(200).json({ message: "Protected data accessed.", user: decoded });
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

/******************************************************
 * SECTION B: Stock Checker Endpoint with Industry Comparison and Forecasting
 ******************************************************/
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent } = req.body;
  if (!symbol || !intent) {
    return res.status(400).json({ message: "Stock symbol and intent (buy/sell) are required." });
  }

  try {
    // 1) Fetch the main stock data with assetProfile for industry
    let stock;
    try {
      stock = await yahooFinance.quoteSummary(symbol, {
        modules: [
          "financialData",
          "price",
          "summaryDetail",
          "defaultKeyStatistics",
          "assetProfile",
        ],
        validate: false,
        requestOptions,
      });
    } catch (innerErr) {
      console.error(`❌ yahooFinance quoteSummary error for symbol "${symbol}":`, innerErr);
      return res.status(500).json({ message: "Error fetching stock data." });
    }

    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }

    // 2) Build metrics
    const computedAvgVolume =
      stock.summaryDetail?.averageDailyVolume3Month || stock.price?.regularMarketVolume || 0;
    const metrics = {
      volume: stock.price?.regularMarketVolume ?? 0,
      currentPrice: stock.price?.regularMarketPrice ?? 0,
      peRatio: stock.summaryDetail?.trailingPE ?? 0,
      pbRatio: stock.summaryDetail?.priceToBook ?? 0,
      dividendYield: stock.summaryDetail?.dividendYield ?? 0,
      earningsGrowth: stock.financialData?.earningsGrowth ?? 0,
      debtRatio: stock.financialData?.debtToEquity ?? 0,
      dayHigh: stock.price?.regularMarketDayHigh ?? 0,
      dayLow: stock.price?.regularMarketDayLow ?? 0,
      fiftyTwoWeekHigh: stock.summaryDetail?.fiftyTwoWeekHigh ?? 0,
      fiftyTwoWeekLow: stock.summaryDetail?.fiftyTwoWeekLow ?? 0,
    };

    // --- Base Scoring ---
    let baseScore = 0;
    if (metrics.volume > computedAvgVolume * 1.1) baseScore += 2;
    else if (metrics.volume < computedAvgVolume * 0.9) baseScore -= 2;

    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) baseScore += 2;
    else if (metrics.peRatio > 20) baseScore -= 1;

    if (metrics.earningsGrowth > 0.05) baseScore += 2;
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) baseScore += 2;
    else if (metrics.debtRatio > 0.7) baseScore -= 2;

    // --- Day Range ---
    const dayRange = metrics.dayHigh - metrics.dayLow;
    let dayScore = 0;
    if (dayRange > 0) {
      const dayPosition = (metrics.currentPrice - metrics.dayLow) / dayRange;
      dayScore = dayPosition < 0.3 ? 1 : -1;
    }

    // --- 52-Week Range ---
    const weekRange = metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow;
    let weekScore = 0;
    if (weekRange > 0) {
      const weekPosition = (metrics.currentPrice - metrics.fiftyTwoWeekLow) / weekRange;
      weekScore = weekPosition < 0.5 ? 2 : -2;
    }

    // --- Industry Comparison ---
    const stockIndustry = stock.assetProfile?.industry || stock.assetProfile?.sector || "Unknown";
    let industryScore = 0;
    if (stockIndustry !== "Unknown" && industryMetrics[stockIndustry]) {
      const indMetrics = industryMetrics[stockIndustry];
      // P/E
      if (metrics.peRatio && indMetrics.peRatio) {
        industryScore += metrics.peRatio < indMetrics.peRatio ? 2 : -2;
      }
      // Earnings Growth vs. Industry
      if (metrics.earningsGrowth && indMetrics.revenueGrowth) {
        industryScore += metrics.earningsGrowth * 100 > indMetrics.revenueGrowth ? 2 : -2;
      }
      // Debt
      if (metrics.debtRatio && indMetrics.debtToEquity) {
        industryScore += metrics.debtRatio < indMetrics.debtToEquity ? 2 : -2;
      }
    }

    // --- Forecasting ---
    let industryGrowthFraction = 0;
    if (
      stockIndustry !== "Unknown" &&
      industryMetrics[stockIndustry] &&
      industryMetrics[stockIndustry].revenueGrowth
    ) {
      industryGrowthFraction = industryMetrics[stockIndustry].revenueGrowth / 100;
    }
    // dayScore is a bonus
    const bonus = dayScore > 0 ? 0.02 : -0.02;
    const fundamentalForecast =
      metrics.currentPrice * (1 + (metrics.earningsGrowth + industryGrowthFraction) / 2 + bonus);

    // Historical forecast (1y)
    let historicalForecast = fundamentalForecast;
    try {
      const historicalData = await yahooFinance.historical(symbol, {
        period: "1y",
        interval: "1d",
        requestOptions,
      });
      if (historicalData && historicalData.length > 1) {
        historicalData.sort((a, b) => new Date(a.date) - new Date(b.date));
        let totalReturn = 0;
        let count = 0;
        for (let i = 1; i < historicalData.length; i++) {
          const prevClose = historicalData[i - 1].close;
          const currClose = historicalData[i].close;
          if (prevClose && currClose) {
            totalReturn += currClose / prevClose - 1;
            count++;
          }
        }
        const avgDailyReturn = count > 0 ? totalReturn / count : 0;
        // ~22 trading days in a month
        historicalForecast = metrics.currentPrice * (1 + avgDailyReturn * 22);
      }
    } catch (histErr) {
      console.error("Historical data fetch error:", histErr.message);
    }

    // Combine forecasts
    const weightFundamental = 0.6;
    const weightHistorical = 0.4;
    const combinedForecast =
      (fundamentalForecast * weightFundamental + historicalForecast * weightHistorical) /
      (weightFundamental + weightHistorical);

    const projectedGrowthPercent =
      ((combinedForecast - metrics.currentPrice) / metrics.currentPrice) * 100;

    // --- Final Combined Score ---
    const combinedScore = baseScore + dayScore + weekScore + industryScore + projectedGrowthPercent;

    // Advice
    let finalClassification;
    let finalAdvice;
    if (intent === "buy") {
      if (combinedScore >= 40) {
        finalClassification = "growth";
        finalAdvice = "Very Good Stock to Buy";
      } else if (combinedScore >= 20) {
        finalClassification = "growth";
        finalAdvice = "Good Stock to Buy";
      } else if (combinedScore >= 0) {
        finalClassification = "stable";
        finalAdvice = "Okay Stock to Buy";
      } else {
        finalClassification = "unstable";
        finalAdvice = "Bad Stock to Buy";
      }
    } else if (intent === "sell") {
      // If forecast is above 7% growth => hold
      if (projectedGrowthPercent > 7) {
        finalClassification = "stable";
        finalAdvice =
          "Hold the Stock (Forecast indicates significant growth; further analysis recommended)";
      } else {
        finalClassification = "unstable";
        finalAdvice = "Sell the Stock";
      }
    }

    // Forecast End Date
    const forecastPeriodDays = 22;
    const forecastEndDate = new Date(Date.now() + forecastPeriodDays * 24 * 60 * 60 * 1000);

    return res.json({
      symbol,
      industry: stockIndustry,
      combinedScore: combinedScore.toFixed(2),
      classification: finalClassification,
      advice: finalAdvice,
      metrics: {
        ...metrics,
        dayRange: metrics.dayHigh - metrics.dayLow,
        fiftyTwoWeekRange: metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow,
      },
      forecast: {
        forecastPrice: combinedForecast.toFixed(2),
        projectedGrowthPercent: projectedGrowthPercent.toFixed(2) + "%",
        forecastPeriod: "1 month",
        forecastEndDate: forecastEndDate.toISOString(),
      },
    });
  } catch (error) {
    console.error("❌ Error fetching stock data:", error.message);
    return res.status(500).json({ message: "Error fetching stock data.", error: error.message });
  }
});

/******************************************************
 * SECTION C: Stock-Finder Extra Endpoints
 ******************************************************/
const finderRouter = express.Router();

finderRouter.post("/api/find-stocks", async (req, res) => {
  console.log("⏰ Incoming body for find-stocks:", req.body);
  const { stockType, exchange, maxPrice } = req.body;
  if (!stockType || !exchange || maxPrice == null) {
    console.log("❌ Validation failed. Body was:", req.body);
    return res
      .status(400)
      .json({ message: "stockType, exchange, and maxPrice are required." });
  }
  if (stockType !== "growth" && stockType !== "stable") {
    console.log("❌ Unknown stockType:", stockType);
    return res
      .status(400)
      .json({ message: "stockType must be either 'growth' or 'stable'." });
  }

  const symbolGroups = require(path.join(__dirname, "symbols.json"));
  console.log("Loaded symbolGroups:", symbolGroups);

  const symbolsForExchange = symbolGroups[exchange.toUpperCase()];
  if (!symbolsForExchange || symbolsForExchange.length === 0) {
    return res
      .status(404)
      .json({ message: `No symbols found for the exchange: ${exchange}` });
  }

  // 1) Convert each symbol into { symbol, exchange }
  let filteredSymbols = symbolsForExchange.map((symbolStr) => ({
    symbol: symbolStr,
    exchange,
  }));

  // 2) Fetch data for each symbol
  let detailedStocks = await Promise.all(
    filteredSymbols.map(async (symObj) => {
      try {
        await delay(200);
        const detailed = await yahooFinance.quoteSummary(symObj.symbol, {
          modules: ["financialData", "price", "summaryDetail", "defaultKeyStatistics"],
          validate: false,
          requestOptions,
        });
        return { ...symObj, detailed };
      } catch (error) {
        console.error(`Error fetching data for ${symObj.symbol}:`, error.message);
        return null;
      }
    })
  );

  // 3) Filter out nulls
  detailedStocks = detailedStocks.filter((stock) => stock !== null);
  console.log("🔎 Checking current prices for symbols in exchange:", exchange);

  detailedStocks.forEach((stock) => {
    const currentPrice = stock.detailed?.price?.regularMarketPrice;
    console.log(`Symbol: ${stock.symbol} - Current Price: ${currentPrice}`);
  });

  // 4) Filter by maxPrice
  let priceFilteredStocks = detailedStocks.filter((stock) => {
    const currentPrice = stock.detailed?.price?.regularMarketPrice;
    console.log(
      `Comparing ${stock.symbol}: Current Price = ${currentPrice}, maxPrice = ${maxPrice}`
    );
    return currentPrice !== undefined && currentPrice <= maxPrice;
  });

  if (priceFilteredStocks.length === 0) {
    let prices = detailedStocks.map((stock) => ({
      symbol: stock.symbol,
      currentPrice: stock.detailed?.price?.regularMarketPrice,
    }));
    console.warn("No stocks passed the maxPrice filter. Available prices:", prices);
    return res.status(404).json({
      message:
        "No stocks found with a price at or below the specified maxPrice. Please adjust your maxPrice.",
    });
  }

  // 5) Compute an internal "stockScore" (like old rating) for classification
  const totalVolume = priceFilteredStocks.reduce((sum, stock) => {
    const vol = stock.detailed?.price?.regularMarketVolume ?? 0;
    return sum + vol;
  }, 0);
  const avgVolume = totalVolume / priceFilteredStocks.length;
  console.log(`Calculated average volume: ${avgVolume}`);

  const evaluatedStocks = priceFilteredStocks.map((stock) => {
    const priceData = stock.detailed.price || {};
    const summaryData = stock.detailed.summaryDetail || {};
    const financialData = stock.detailed.financialData || {};

    const metrics = {
      volume: priceData.regularMarketVolume ?? 0,
      currentPrice: priceData.regularMarketPrice ?? 0,
      peRatio: summaryData.trailingPE ?? 0,
      // Not including pbRatio or dividendYield here
      earningsGrowth: financialData.earningsGrowth ?? 0,
      debtRatio: financialData.debtToEquity ?? 0,
      avg50Days: priceData.fiftyDayAverage ?? 0,
      avg200Days: priceData.twoHundredDayAverage ?? 0,
    };

    // Basic scoring
    let stockScore = 0;
    if (metrics.volume > avgVolume * 1.1) stockScore += 2;
    else if (metrics.volume < avgVolume * 0.9) stockScore -= 2;

    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) stockScore += 2;
    else if (metrics.peRatio > 20) stockScore -= 1;

    if (metrics.earningsGrowth > 0.05) stockScore += 2;
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) stockScore += 2;
    else if (metrics.debtRatio > 0.7) stockScore -= 2;

    // Classify based on the basic stockScore
    const classification =
      stockScore > 7 ? "growth" : stockScore >= 0 ? "stable" : "unstable";

    let advice;
    if (stockScore >= 8) advice = "Very Good Stock to Buy";
    else if (stockScore >= 5) advice = "Good Stock to Buy";
    else if (stockScore >= 0) advice = "Okay Stock to Buy";
    else if (stockScore >= -5) advice = "Bad Stock";
    else advice = "Bad Stock to Buy";

    return {
      symbol: stock.symbol,
      exchange: stock.exchange,
      currentPrice: metrics.currentPrice,
      metrics,
      combinedScore: stockScore.toFixed(2),
      classification,
      advice,
    };
  });

  console.log("Evaluated Stocks:", evaluatedStocks);

  // 6) Filter by the requested stockType
  const matchingStocks = evaluatedStocks.filter(
    (stock) => stock.classification === stockType
  );

  console.log(`Found ${matchingStocks.length} matching stocks for type "${stockType}".`);
  return res.json({ stocks: matchingStocks });
});

finderRouter.post("/signup", async (req, res) => {
  console.log("Stock Finder - Incoming Request Body:", req.body);
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    console.error("Missing required fields!");
    return res.status(400).json({ message: "All fields are required." });
  }
  try {
    console.log("Stock Finder - Checking if user exists...");
    const existingUser = await UserModel.findOne({ email });
    if (existingUser) {
      console.error("Stock Finder - User already exists!");
      return res.status(400).json({ message: "Email already in use." });
    }
    console.log("Stock Finder - Hashing password...");
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log("Stock Finder - Saving new user...");
    const user = new UserModel({ email, username, password: hashedPassword });
    await user.save();
    console.log("Stock Finder - User saved successfully!");
    return res.status(201).json({ message: "User registered successfully." });
  } catch (error) {
    console.error("Stock Finder - Signup Error:", error);
    return res.status(500).json({ message: "Error during signup." });
  }
});

finderRouter.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required." });
  }
  try {
    const user = await UserModel.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials." });
    }
    return res.status(200).json({ message: "Login successful." });
  } catch (error) {
    console.error("Stock Finder - Login Error:", error);
    return res.status(500).json({ message: "Error during login." });
  }
});

app.use("/finder", finderRouter);

/******************************************************
 * SECTION D: Dashboard Popular Stocks Endpoint with Caching
 ******************************************************/
let popularStocksCache = null;
let popularStocksCacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

app.get("/api/popular-stocks", async (req, res) => {
  const marketState = req.query.marketState || "open";

  // Check if we have fresh cached data
  if (
    popularStocksCache &&
    Date.now() - popularStocksCacheTimestamp < CACHE_DURATION &&
    popularStocksCache.length > 0
  ) {
    console.log("Returning cached popular stocks data.");
    return res.json(popularStocksCache);
  }

  try {
    const symbolGroups = require(path.join(__dirname, "symbols.json"));
    const nasdaqSymbols = symbolGroups["NASDAQ"] || [];
    if (nasdaqSymbols.length === 0) {
      return res.status(404).json({ message: "No symbols available for NASDAQ." });
    }

    // Fetch data for each symbol
    let stockData = await Promise.all(
      nasdaqSymbols.map(async (symbol) => {
        try {
          await delay(200);
          const data = await yahooFinance.quoteSummary(symbol, {
            modules: ["price"],
            validate: false,
            requestOptions,
          });
          return { symbol, price: data.price };
        } catch (error) {
          console.error(`Error fetching data for ${symbol}:`, error.message);
          return null;
        }
      })
    );

    // Filter out failures
    stockData = stockData.filter(
      (s) => s !== null && s.price && s.price.regularMarketChangePercent !== undefined
    );

    // Sort by descending change percent
    stockData.sort(
      (a, b) => b.price.regularMarketChangePercent - a.price.regularMarketChangePercent
    );

    // If marketState=open, keep only positive-changers
    if (marketState === "open") {
      stockData = stockData.filter((s) => s.price.regularMarketChangePercent > 0);
    }

    // Take top 10
    const topStocks = stockData.slice(0, 10).map((s) => ({
      symbol: s.symbol,
      score: s.price.regularMarketChangePercent,
      metrics: {
        currentPrice: s.price.regularMarketPrice,
        changePercent: s.price.regularMarketChangePercent,
        previousClose: s.price.regularMarketPreviousClose,
      },
    }));

    // Cache it
    popularStocksCache = topStocks;
    popularStocksCacheTimestamp = Date.now();

    return res.json(topStocks);
  } catch (error) {
    console.error("❌ Error in /api/popular-stocks:", error.message);
    return res.status(500).json({ message: "Error fetching popular stocks." });
  }
});

/******************************************************
 * SECTION E: Stock Forecasting Endpoint with Pre-Trained Model
 ******************************************************/
app.post("/api/forecast-stock", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    return res.status(400).json({ message: "Stock symbol is required for forecasting." });
  }
  try {
    // 60-day historical range
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 60 * 24 * 60 * 60 * 1000);

    let historicalData;
    try {
      historicalData = await yahooFinance.chart(symbol, {
        period1: startDate,
        period2: endDate,
        interval: "1d",
        requestOptions,
      });
    } catch (innerErr) {
      console.error(`❌ yahooFinance.chart error for symbol "${symbol}":`, innerErr);
      return res.status(500).json({ message: "Error fetching historical data." });
    }

    if (!historicalData || !historicalData.quotes || historicalData.quotes.length < 2) {
      return res
        .status(400)
        .json({ message: "Not enough historical data available for forecasting." });
    }

    // Sort by date ascending
    const sortedData = historicalData.quotes.sort((a, b) => new Date(a.date) - new Date(b.date));
    const closingPrices = sortedData.map((item) => item.close);

    if (!normalizationParams) {
      return res
        .status(500)
        .json({ message: "Normalization parameters not available on the server." });
    }

    const { minPrice, maxPrice } = normalizationParams;
    const normalizedPrices = closingPrices.map(
      (price) => (price - minPrice) / (maxPrice - minPrice)
    );

    // [1, seq_length, 1]
    const inputTensor = tf
      .tensor2d(normalizedPrices, [normalizedPrices.length, 1])
      .reshape([1, normalizedPrices.length, 1]);

    let forecastPriceNormalized;
    if (forecastModel) {
      const predictionTensor = forecastModel.predict(inputTensor);
      forecastPriceNormalized = predictionTensor.dataSync()[0];
    } else {
      forecastPriceNormalized = normalizedPrices[normalizedPrices.length - 1];
    }

    const forecastPrice = forecastPriceNormalized * (maxPrice - minPrice) + minPrice;
    const lastClose = closingPrices[closingPrices.length - 1];
    const projectedGrowthPercent = ((forecastPrice - lastClose) / lastClose) * 100;

    const forecastPeriodDays = 22; // ~1 month
    const forecastEndDate = new Date(Date.now() + forecastPeriodDays * 24 * 60 * 60 * 1000);

    return res.json({
      symbol,
      forecastPrice: forecastPrice.toFixed(2),
      projectedGrowthPercent: projectedGrowthPercent.toFixed(2) + "%",
      forecastPeriod: "1 month",
      forecastEndDate: forecastEndDate.toISOString(),
    });
  } catch (error) {
    console.error("❌ Error forecasting stock price:", error.message);
    return res.status(500).json({ message: "Error forecasting stock price.", error: error.message });
  }
});

/******************************************************
 * START THE COMBINED SERVER
 ******************************************************/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

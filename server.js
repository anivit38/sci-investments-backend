/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, FORECASTING & COMMUNITY
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
const yahooFinance = require("yahoo-finance2").default;
// Use dynamic import for node-fetch (ESM in CommonJS)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// Helper: Delay (in milliseconds)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: Check if the market is open (NYSE hours: M–F, 9:30–16:00 ET)
function isMarketOpen() {
  const now = new Date();
  const options = { timeZone: "America/New_York", hour12: false };
  const estString = now.toLocaleString("en-US", options);
  const est = new Date(estString);
  const day = est.getDay(); // 0: Sunday, 6: Saturday
  if (day === 0 || day === 6) return false;
  const hour = est.getHours();
  const minute = est.getMinutes();
  if (hour < 9 || (hour === 9 && minute < 30)) return false;
  if (hour > 16 || (hour === 16 && minute > 0)) return false;
  return true;
}

// Custom request options for Yahoo Finance
const requestOptions = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36",
  },
  redirect: "follow",
};

// New: Helper function to fetch stock-related news and do a basic sentiment analysis
async function fetchStockNews(query) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    console.warn("No NEWS_API_KEY provided. Skipping news sentiment analysis.");
    return 0; // Neutral sentiment if no API key
  }
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(
    query
  )}&apiKey=${apiKey}&language=en`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.articles) return 0;

    let sentimentScore = 0;
    // Very basic sentiment analysis based on keywords in article titles
    const positiveWords = [
      "growth",
      "profit",
      "record",
      "surge",
      "gain",
      "positive",
      "upgrade",
      "bullish",
    ];
    const negativeWords = [
      "crash",
      "loss",
      "decline",
      "drop",
      "warn",
      "bearish",
      "cut",
      "scandal",
    ];

    data.articles.forEach((article) => {
      const title = article.title.toLowerCase();
      positiveWords.forEach((word) => {
        if (title.includes(word)) sentimentScore += 1;
      });
      negativeWords.forEach((word) => {
        if (title.includes(word)) sentimentScore -= 1;
      });
    });

    console.log(`News sentiment score for "${query}":`, sentimentScore);
    return sentimentScore;
  } catch (error) {
    console.error("Error fetching stock news:", error.message);
    return 0;
  }
}

// 2. Models & External APIs
const UserModel = require(path.join(__dirname, "models", "User"));

// New: CommunityPost Model for the community page
const communityPostSchema = new mongoose.Schema({
  username: { type: String, required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const CommunityPost = mongoose.model("CommunityPost", communityPostSchema);

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
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/sci_investments";
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
    forecastModel = await tf.loadLayersModel(
      "file://model/forecast_model/model.json"
    );
    console.log("✅ Forecast model loaded successfully.");
    const normPath = path.join(
      __dirname,
      "model",
      "forecast_model",
      "normalization.json"
    );
    const normData = fs.readFileSync(normPath);
    normalizationParams = JSON.parse(normData);
    console.log("✅ Normalization parameters loaded:", normalizationParams);
  } catch (error) {
    console.error("❌ Error loading forecast resources:", error.message);
  }
}
loadForecastResources();

// 5. Implement Caching for Yahoo Finance Stock Data
const stockDataCache = {}; // Key: symbol, Value: { data, timestamp }
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes TTL

async function fetchStockData(symbol) {
  const now = Date.now();
  const marketOpen = isMarketOpen();
  if (!marketOpen && stockDataCache[symbol]) {
    console.log(`Market closed, using cached data for ${symbol}`);
    return stockDataCache[symbol].data;
  }
  if (
    stockDataCache[symbol] &&
    now - stockDataCache[symbol].timestamp < CACHE_TTL
  ) {
    console.log(`Using cached data for ${symbol}`);
    return stockDataCache[symbol].data;
  }
  console.log(`Fetching fresh data for ${symbol}`);
  const modules = [
    "financialData",
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
    "assetProfile",
  ];
  try {
    const data = await yahooFinance.quoteSummary(symbol, {
      modules,
      validate: false,
      requestOptions,
    });
    stockDataCache[symbol] = { data, timestamp: now };
    return data;
  } catch (err) {
    console.error(`❌ Error fetching data for ${symbol}:`, err.message);
    throw err;
  }
}

// --- Auth Endpoints ---
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
    if (existingUser)
      return res.status(400).json({ message: "Email already in use." });
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
  if (!username || !password)
    return res
      .status(400)
      .json({ message: "Username and password are required." });
  try {
    const user = await UserModel.findOne({ username });
    if (!user) return res.status(401).json({ message: "Invalid credentials." });
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      return res.status(401).json({ message: "Invalid credentials." });
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
    console.log("✅ Login Successful:", username);
    return res.status(200).json({ message: "Login successful.", token });
  } catch (error) {
    console.error("❌ Login Error:", error.message);
    return res.status(500).json({ message: "Error during login." });
  }
});

app.get("/protected", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token)
    return res.status(401).json({ message: "Unauthorized. Token required." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res
      .status(200)
      .json({ message: "Protected data accessed.", user: decoded });
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

// --- Stock Checker Endpoint with Industry Comparison, Forecasting, and News Sentiment ---
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent } = req.body;
  if (!symbol || !intent)
    return res
      .status(400)
      .json({ message: "Stock symbol and intent (buy/sell) are required." });
  try {
    let stock;
    try {
      stock = await fetchStockData(symbol);
    } catch (innerErr) {
      console.error(
        `❌ Error fetching stock data for symbol "${symbol}":`,
        innerErr.message
      );
      return res.status(500).json({ message: "Error fetching stock data." });
    }
    if (!stock || !stock.price)
      return res
        .status(404)
        .json({ message: "Stock not found or data unavailable." });

    const computedAvgVolume =
      stock.summaryDetail?.averageDailyVolume3Month ||
      stock.price?.regularMarketVolume ||
      0;
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

    // Base scoring
    let baseScore = 0;
    if (metrics.volume > computedAvgVolume * 1.1) baseScore += 2;
    else if (metrics.volume < computedAvgVolume * 0.9) baseScore -= 2;

    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) baseScore += 2;
    else if (metrics.peRatio > 20) baseScore -= 1;

    if (metrics.earningsGrowth > 0.05) baseScore += 2;
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) baseScore += 2;
    else if (metrics.debtRatio > 0.7) baseScore -= 2;

    // Day range scoring
    const dayRange = metrics.dayHigh - metrics.dayLow;
    let dayScore = 0;
    if (dayRange > 0) {
      const dayPosition = (metrics.currentPrice - metrics.dayLow) / dayRange;
      dayScore = dayPosition < 0.3 ? 1 : -1;
    }

    // 52-week range scoring
    const weekRange = metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow;
    let weekScore = 0;
    if (weekRange > 0) {
      const weekPosition =
        (metrics.currentPrice - metrics.fiftyTwoWeekLow) / weekRange;
      weekScore = weekPosition < 0.5 ? 2 : -2;
    }

    // Industry comparison
    const stockIndustry =
      stock.assetProfile?.industry || stock.assetProfile?.sector || "Unknown";
    let industryScore = 0;
    if (stockIndustry !== "Unknown" && industryMetrics[stockIndustry]) {
      const indMetrics = industryMetrics[stockIndustry];
      if (metrics.peRatio && indMetrics.peRatio) {
        industryScore +=
          metrics.peRatio < indMetrics.peRatio ? 2 : -2;
      }
      if (metrics.earningsGrowth && indMetrics.revenueGrowth) {
        industryScore +=
          metrics.earningsGrowth * 100 > indMetrics.revenueGrowth ? 2 : -2;
      }
      if (metrics.debtRatio && indMetrics.debtToEquity) {
        industryScore +=
          metrics.debtRatio < indMetrics.debtToEquity ? 2 : -2;
      }
    }

    // Forecasting (using historical data)
    let industryGrowthFraction = 0;
    if (
      stockIndustry !== "Unknown" &&
      industryMetrics[stockIndustry] &&
      industryMetrics[stockIndustry].revenueGrowth
    ) {
      industryGrowthFraction =
        industryMetrics[stockIndustry].revenueGrowth / 100;
    }
    const bonus = dayScore > 0 ? 0.02 : -0.02;
    const fundamentalForecast =
      metrics.currentPrice *
      (1 + (metrics.earningsGrowth + industryGrowthFraction) / 2 + bonus);

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
        historicalForecast = metrics.currentPrice * (1 + avgDailyReturn * 22);
      }
    } catch (histErr) {
      console.error("Historical data fetch error:", histErr.message);
    }

    // Combine forecasts
    const weightFundamental = 0.6;
    const weightHistorical = 0.4;
    let combinedForecast =
      (fundamentalForecast * weightFundamental +
        historicalForecast * weightHistorical) /
      (weightFundamental + weightHistorical);

    // Adjust forecast based on recent news sentiment
    const newsSentiment = await fetchStockNews(symbol);
    // Adjust forecast by 0.5% of currentPrice per sentiment point
    const sentimentAdjustment = newsSentiment * 0.005 * metrics.currentPrice;
    combinedForecast += sentimentAdjustment;

    const projectedGrowthPercent =
      ((combinedForecast - metrics.currentPrice) / metrics.currentPrice) * 100;

    const fundamentalRating = baseScore + dayScore + weekScore + industryScore;
    const combinedScore = fundamentalRating + projectedGrowthPercent;

    let finalClassification, finalAdvice;
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
      if (projectedGrowthPercent > 7) {
        finalClassification = "stable";
        finalAdvice =
          "Hold the Stock (Forecast indicates significant growth; further analysis recommended)";
      } else {
        finalClassification = "unstable";
        finalAdvice = "Sell the Stock";
      }
    }

    const forecastPeriodDays = 22;
    const forecastEndDate = new Date(
      Date.now() + forecastPeriodDays * 24 * 60 * 60 * 1000
    );

    return res.json({
      symbol,
      industry: stockIndustry,
      fundamentalRating: fundamentalRating.toFixed(2),
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
    console.error("❌ Error in /api/check-stock:", error.message);
    return res
      .status(500)
      .json({ message: "Error fetching stock data.", error: error.message });
  }
});

// --- Finder Endpoints ---
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
  let filteredSymbols = symbolsForExchange.map((symbolStr) => ({
    symbol: symbolStr,
    exchange,
  }));
  let detailedStocks = await Promise.all(
    filteredSymbols.map(async (symObj) => {
      try {
        await delay(200);
        const detailed = await fetchStockData(symObj.symbol);
        return { ...symObj, detailed };
      } catch (error) {
        console.error(`Error fetching data for ${symObj.symbol}:`, error.message);
        return null;
      }
    })
  );
  detailedStocks = detailedStocks.filter((stock) => stock !== null);
  console.log("🔎 Checking current prices for symbols in exchange:", exchange);
  detailedStocks.forEach((stock) => {
    const currentPrice = stock.detailed?.price?.regularMarketPrice;
    console.log(`Symbol: ${stock.symbol} - Current Price: ${currentPrice}`);
  });
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
      earningsGrowth: financialData.earningsGrowth ?? 0,
      debtRatio: financialData.debtToEquity ?? 0,
      avg50Days: priceData.fiftyDayAverage ?? 0,
      avg200Days: priceData.twoHundredDayAverage ?? 0,
    };

    let stockScore = 0;
    if (metrics.volume > avgVolume * 1.1) stockScore += 2;
    else if (metrics.volume < avgVolume * 0.9) stockScore -= 2;

    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) stockScore += 2;
    else if (metrics.peRatio > 20) stockScore -= 1;

    if (metrics.earningsGrowth > 0.05) stockScore += 2;
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) stockScore += 2;
    else if (metrics.debtRatio > 0.7) stockScore -= 2;

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
    return res
      .status(400)
      .json({ message: "Username and password are required." });
  }
  try {
    const user = await UserModel.findOne({ username });
    if (!user) return res.status(401).json({ message: "Invalid credentials." });
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      return res.status(401).json({ message: "Invalid credentials." });
    return res.status(200).json({ message: "Login successful." });
  } catch (error) {
    console.error("Stock Finder - Login Error:", error);
    return res.status(500).json({ message: "Error during login." });
  }
});

app.use("/finder", finderRouter);

// --- Popular Stocks Endpoint with Caching ---
let popularStocksCache = null;
let popularStocksCacheTimestamp = 0;
const POPULAR_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

app.get("/api/popular-stocks", async (req, res) => {
  const marketState = req.query.marketState || "open";
  // (Optional) parse sort parameter from query: e.g., ?sort=volume
  const sortParam = req.query.sort || "gainers";

  // Check if we have cached data and it's still valid
  if (
    popularStocksCache &&
    Date.now() - popularStocksCacheTimestamp < POPULAR_CACHE_DURATION &&
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

    let stockData = await Promise.all(
      nasdaqSymbols.map(async (symbol) => {
        try {
          await delay(200);
          const data = await fetchStockData(symbol);
          return { symbol, price: data.price };
        } catch (error) {
          console.error(`Error fetching data for ${symbol}:`, error.message);
          return null;
        }
      })
    );

    // Filter out null or incomplete data
    stockData = stockData.filter(
      (s) =>
        s !== null && s.price && s.price.regularMarketChangePercent !== undefined
    );

    // Sorting logic
    if (sortParam === "volume") {
      // sort by highest volume
      stockData.sort(
        (a, b) =>
          (b.price.regularMarketVolume || 0) - (a.price.regularMarketVolume || 0)
      );
    } else {
      // default: sort by biggest % change
      stockData.sort(
        (a, b) =>
          b.price.regularMarketChangePercent - a.price.regularMarketChangePercent
      );
    }

    // If marketState is "open", optionally filter out negative or zero changes
    if (marketState === "open") {
      stockData = stockData.filter((s) => s.price.regularMarketChangePercent > 0);
    }

    // Pick the top 10
    const topStocks = stockData.slice(0, 10).map((s) => ({
      symbol: s.symbol,
      score:
        sortParam === "volume"
          ? s.price.regularMarketVolume
          : s.price.regularMarketChangePercent,
      metrics: {
        currentPrice: s.price.regularMarketPrice,
        changePercent: s.price.regularMarketChangePercent,
        previousClose: s.price.regularMarketPreviousClose,
      },
    }));

    // Cache results
    popularStocksCache = topStocks;
    popularStocksCacheTimestamp = Date.now();

    return res.json(topStocks);
  } catch (error) {
    console.error("❌ Error in /api/popular-stocks:", error.message);
    return res.status(500).json({ message: "Error fetching popular stocks." });
  }
});

// --- Stock Forecasting Endpoint with News Sentiment Adjustment ---
app.post("/api/forecast-stock", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    return res
      .status(400)
      .json({ message: "Stock symbol is required for forecasting." });
  }
  try {
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

    // Sort data by date ascending
    const sortedData = historicalData.quotes.sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    const closingPrices = sortedData.map((item) => item.close);

    // Make sure we have normalization params
    if (!normalizationParams) {
      return res
        .status(500)
        .json({ message: "Normalization parameters not available on the server." });
    }

    const { minPrice, maxPrice } = normalizationParams;
    const normalizedPrices = closingPrices.map(
      (price) => (price - minPrice) / (maxPrice - minPrice)
    );

    // Prepare input tensor
    const inputTensor = tf
      .tensor2d(normalizedPrices, [normalizedPrices.length, 1])
      .reshape([1, normalizedPrices.length, 1]);

    let forecastPriceNormalized;
    if (forecastModel) {
      const predictionTensor = forecastModel.predict(inputTensor);
      forecastPriceNormalized = predictionTensor.dataSync()[0];
    } else {
      // If no model, fallback to last known
      forecastPriceNormalized = normalizedPrices[normalizedPrices.length - 1];
    }

    // Convert back to actual price
    let forecastPrice = forecastPriceNormalized * (maxPrice - minPrice) + minPrice;
    const lastClose = closingPrices[closingPrices.length - 1];

    // Adjust forecast using news sentiment
    const newsSentiment = await fetchStockNews(symbol);
    const sentimentAdjustment = newsSentiment * 0.005 * lastClose;
    forecastPrice += sentimentAdjustment;

    const projectedGrowthPercent = ((forecastPrice - lastClose) / lastClose) * 100;
    const forecastPeriodDays = 22;
    const forecastEndDate = new Date(
      Date.now() + forecastPeriodDays * 24 * 60 * 60 * 1000
    );

    return res.json({
      symbol,
      forecastPrice: forecastPrice.toFixed(2),
      projectedGrowthPercent: projectedGrowthPercent.toFixed(2) + "%",
      forecastPeriod: "1 month",
      forecastEndDate: forecastEndDate.toISOString(),
    });
  } catch (error) {
    console.error("❌ Error forecasting stock price:", error.message);
    return res
      .status(500)
      .json({ message: "Error forecasting stock price.", error: error.message });
  }
});

// --- Community Endpoints ---
// GET all community posts
app.get("/api/community-posts", async (req, res) => {
  try {
    const posts = await CommunityPost.find().sort({ createdAt: -1 });
    return res.json({ posts });
  } catch (error) {
    console.error("Error fetching community posts:", error.message);
    return res.status(500).json({ message: "Error fetching posts." });
  }
});

// POST a new community post
app.post("/api/community-posts", async (req, res) => {
  const { username, message } = req.body;
  if (!username || !message) {
    return res
      .status(400)
      .json({ message: "Username and message are required." });
  }
  try {
    const newPost = new CommunityPost({ username, message });
    await newPost.save();
    return res
      .status(201)
      .json({ message: "Post created successfully.", post: newPost });
  } catch (error) {
    console.error("Error creating community post:", error.message);
    return res.status(500).json({ message: "Error creating post." });
  }
});

// --- Notifications Endpoint (New) ---
app.get("/api/notifications", (req, res) => {
  // Example notifications; in a real app you might fetch from DB
  const sampleNotifications = [
    {
      title: "Market Alert: High Volatility in Tech",
      message:
        "Tech stocks are experiencing high volatility due to earnings season.",
      createdAt: new Date().toISOString(),
    },
    {
      title: "Portfolio Update",
      message:
        "Your watchlist stocks have changed by an average of +2% this week.",
      createdAt: new Date().toISOString(),
    },
  ];
  return res.json({ notifications: sampleNotifications });
});

// --- Start the Server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

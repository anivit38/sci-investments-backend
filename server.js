/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, FORECASTING, COMMUNITY
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
const nodemailer = require("nodemailer");

// Set up Nodemailer transporter (using Gmail as example)
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.NOTIFY_EMAIL,
    pass: process.env.NOTIFY_PASSWORD,
  },
});

// Helper function to send a sell notification email
function sendSellNotification(symbol, currentPrice, reasons) {
  const message = `[AutoSell] Selling ${symbol} at $${currentPrice}. Reasons: ${reasons.join(", ")}`;
  const mailOptions = {
    from: process.env.NOTIFY_EMAIL,
    to: process.env.NOTIFY_RECIPIENT,
    subject: `Sell Alert: ${symbol}`,
    text: message,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("Error sending notification email:", error);
    } else {
      console.log("Notification email sent:", info.response);
    }
  });
}

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
  const day = est.getDay();
  if (day === 0 || day === 6) return false;
  const hour = est.getHours();
  const minute = est.getMinutes();
  if (hour < 9 || (hour === 9 && minute < 30)) return false;
  if (hour > 16 || (hour === 16 && minute > 0)) return false;
  return true;
}

// Helper: End-of-day time (for display)
function getMarketCloseTime() {
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  etNow.setHours(16, 0, 0, 0); // 4:00 pm
  return etNow;
}

// Custom request options for Yahoo Finance
const requestOptions = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36",
  },
  redirect: "follow",
};

// Helper function to fetch stock-related news (sentiment analysis)
async function fetchStockNews(query) {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    console.warn("No NEWS_API_KEY provided. Skipping news sentiment analysis.");
    return 0;
  }
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(
    query
  )}&apiKey=${apiKey}&language=en`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!data.articles) return 0;
    let sentimentScore = 0;
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

// CommunityPost Model
const communityPostSchema = new mongoose.Schema({
  username: { type: String, required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const CommunityPost = mongoose.model("CommunityPost", communityPostSchema);

// 2.1 Load industry metrics
let industryMetrics = {};
try {
  industryMetrics = require("./industryMetrics.json");
} catch (err) {
  console.error("Error loading industryMetrics.json:", err.message);
}

// 3. Create Express App
const app = express();
app.use(
  cors({
    origin: "https://sci-investments.web.app",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);
app.options("*", cors());
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

// 5. Implement Caching for Yahoo Finance Stock Data
const stockDataCache = {};
const CACHE_TTL = 15 * 60 * 1000;
async function fetchStockData(symbol) {
  const now = Date.now();
  const marketOpen = isMarketOpen();
  // If market is closed, or cache is fresh, use cache
  if (!marketOpen && stockDataCache[symbol]) {
    console.log(`Market closed, using cached data for ${symbol}`);
    return stockDataCache[symbol].data;
  }
  if (stockDataCache[symbol] && now - stockDataCache[symbol].timestamp < CACHE_TTL) {
    console.log(`Using cached data for ${symbol}`);
    return stockDataCache[symbol].data;
  }
  console.log(`Fetching fresh data for ${symbol}`);
  const modules = ["financialData", "price", "summaryDetail", "defaultKeyStatistics", "assetProfile"];
  try {
    const data = await yahooFinance.quoteSummary(
      symbol,
      { modules, validateResult: false },
      { fetchOptions: requestOptions }
    );
    stockDataCache[symbol] = { data, timestamp: now };
    return data;
  } catch (err) {
    console.error(`❌ Error fetching data for ${symbol}:`, err.message);
    throw err;
  }
}

// --- Historical Data for Charting ---
app.post("/api/stock-history", async (req, res) => {
  const { symbol, range } = req.body;
  if (!symbol) return res.status(400).json({ message: "Stock symbol is required." });
  let days;
  switch (range) {
    case "1d": days = 1; break;
    case "5d": days = 5; break;
    case "1w": days = 7; break;
    case "1m": days = 30; break;
    case "6m": days = 180; break;
    case "1y": days = 365; break;
    case "MAX": days = 1825; break;
    default: days = 30; break;
  }
  try {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    const historicalData = await yahooFinance.historical(
      symbol,
      { period1: startDate, period2: endDate, interval: "1d" },
      { fetchOptions: requestOptions }
    );
    if (!historicalData || historicalData.length === 0)
      return res.status(404).json({ message: "No historical data found for this symbol." });
    historicalData.sort((a, b) => new Date(a.date) - new Date(b.date));
    const chartData = historicalData.map((item) => ({
      date: item.date,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    }));
    return res.json({ symbol, range: range || "1m", data: chartData });
  } catch (error) {
    console.error("Error fetching historical data:", error.message);
    return res.status(500).json({ message: "Error fetching historical data." });
  }
});

// --- Auth Endpoints ---
app.get("/", (req, res) => res.send("✅ Combined Server is running!"));

app.post("/signup", async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password)
    return res.status(400).json({ message: "All fields are required." });
  try {
    const existingUser = await UserModel.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "Email already in use." });
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
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "Username and password are required." });
  try {
    const user = await UserModel.findOne({ username });
    if (!user) return res.status(401).json({ message: "Invalid credentials." });
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ message: "Invalid credentials." });
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
  if (!token)
    return res.status(401).json({ message: "Unauthorized. Token required." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.status(200).json({ message: "Protected data accessed.", user: decoded });
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

/*******************************************
 * ADVANCED END-OF-DAY FORECASTING - STOCK CHECKER
 *******************************************/
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent } = req.body;
  if (!symbol || !intent) {
    return res.status(400).json({ message: "Stock symbol and intent (buy/sell) are required." });
  }
  try {
    let stock;
    try {
      stock = await fetchStockData(symbol);
    } catch (innerErr) {
      console.error(`❌ Error fetching stock data for symbol "${symbol}":`, innerErr.message);
      return res.status(500).json({ message: "Error fetching stock data." });
    }
    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }

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

    // Fundamental scoring (adjust thresholds)
    let baseScore = 0;
    if (metrics.volume > computedAvgVolume * 1.2) baseScore += 3;
    else if (metrics.volume < computedAvgVolume * 0.8) baseScore -= 2;

    if (metrics.peRatio >= 5 && metrics.peRatio <= 20) baseScore += 2;
    else if (metrics.peRatio > 40) baseScore -= 2;

    if (metrics.earningsGrowth > 0.2) baseScore += 4;
    else if (metrics.earningsGrowth > 0.05) baseScore += 2;
    else if (metrics.earningsGrowth < 0) baseScore -= 2;

    if (metrics.debtRatio < 0.3) baseScore += 3;
    else if (metrics.debtRatio > 1) baseScore -= 2;

    // Day range score
    let dayScore = 0;
    const dayRange = metrics.dayHigh - metrics.dayLow;
    if (dayRange > 0) {
      const dayPos = (metrics.currentPrice - metrics.dayLow) / dayRange;
      if (dayPos < 0.2) dayScore = 1;
      else if (dayPos > 0.8) dayScore = -1;
    }

    // 52-week range score
    let weekScore = 0;
    const weekRange = metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow;
    if (weekRange > 0) {
      const weekPos = (metrics.currentPrice - metrics.fiftyTwoWeekLow) / weekRange;
      if (weekPos < 0.3) weekScore = 2;
      else if (weekPos > 0.8) weekScore = -2;
    }

    // Industry comparison score
    let industryScore = 0;
    const stockIndustry = stock.assetProfile?.industry || stock.assetProfile?.sector || "Unknown";
    if (stockIndustry !== "Unknown" && industryMetrics[stockIndustry]) {
      const ind = industryMetrics[stockIndustry];
      if (metrics.peRatio && ind.peRatio) {
        industryScore += metrics.peRatio < ind.peRatio ? 2 : -2;
      }
      if (metrics.earningsGrowth && ind.revenueGrowth) {
        industryScore += metrics.earningsGrowth * 100 > ind.revenueGrowth ? 2 : -2;
      }
      if (metrics.debtRatio && ind.debtToEquity) {
        industryScore += metrics.debtRatio < ind.debtToEquity ? 2 : -2;
      }
    }

    // Attempt advanced model forecast for EOD
    let advancedForecastPrice = null;
    if (forecastModel && normalizationParams) {
      try {
        const featureKeys = ["currentPrice", "peRatio", "earningsGrowth", "debtRatio", "volume"];
        const values = featureKeys.map((k) => metrics[k] || 0);
        const normalized = values.map((val, i) => {
          const k = featureKeys[i];
          const mean = normalizationParams[k]?.mean || 0;
          const std = normalizationParams[k]?.std || 1;
          return (val - mean) / std;
        });
        const inputTensor = tf.tensor2d([normalized]);
        const pred = forecastModel.predict(inputTensor);
        const predVal = pred.dataSync()[0];
        const cpMean = normalizationParams.currentPrice?.mean || 0;
        const cpStd = normalizationParams.currentPrice?.std || 1;
        advancedForecastPrice = predVal * cpStd + cpMean;
      } catch (tfErr) {
        console.error(`Model forecast error for ${symbol}:`, tfErr.message);
      }
    }

    // Fallback: short-term historical approach if advanced forecast failed
    let finalForecastPrice = advancedForecastPrice;
    if (!finalForecastPrice) {
      try {
        const fallbackData = await yahooFinance.historical(
          symbol,
          { period: "5d", interval: "1d" },
          { fetchOptions: requestOptions }
        );
        if (fallbackData && fallbackData.length > 1) {
          fallbackData.sort((a, b) => new Date(a.date) - new Date(b.date));
          let totalReturn = 0;
          let count = 0;
          for (let i = 1; i < fallbackData.length; i++) {
            const prevClose = fallbackData[i - 1].close;
            const currClose = fallbackData[i].close;
            if (prevClose && currClose) {
              totalReturn += currClose / prevClose - 1;
              count++;
            }
          }
          const avgDailyReturn = count > 0 ? totalReturn / count : 0;
          finalForecastPrice = metrics.currentPrice * (1 + avgDailyReturn);
        }
      } catch (fbErr) {
        console.error(`Fallback forecast error for ${symbol}:`, fbErr.message);
      }
    }
    if (!finalForecastPrice) {
      finalForecastPrice = metrics.currentPrice;
    }

    // --- New Scoring System ---
    // Calculate fundamental rating as before:
    const fundamentalRating = baseScore + dayScore + weekScore + industryScore;
    // Calculate projected growth percent:
    const projectedGrowthPercent = ((finalForecastPrice - metrics.currentPrice) / metrics.currentPrice) * 100;
    // Apply new weights so that forecast has more influence:
    const weightFundamental = 0.4;
    const weightForecast = 0.6;
    const numericCombinedScore = +((weightFundamental * fundamentalRating) + (weightForecast * projectedGrowthPercent)).toFixed(2);

    // Classification logic that also considers forecast direction:
    let finalClassification, finalAdvice;
    if (intent === "buy") {
      if (projectedGrowthPercent < 0) {
        finalClassification = "unstable";
        finalAdvice = "Bad Stock to Buy (Forecast negative)";
      } else if (numericCombinedScore >= 30) {
        finalClassification = "growth";
        finalAdvice = "Very Good Stock to Buy";
      } else if (numericCombinedScore >= 10) {
        finalClassification = "growth";
        finalAdvice = "Good Stock to Buy";
      } else if (numericCombinedScore >= -5) {
        finalClassification = "stable";
        finalAdvice = "Okay Stock to Buy";
      } else {
        finalClassification = "unstable";
        finalAdvice = "Bad Stock to Buy";
      }
    } else {
      // For selling, if forecast is negative, advise sell.
      if (projectedGrowthPercent < 0) {
        finalClassification = "unstable";
        finalAdvice = "Sell the Stock (Forecast negative)";
      } else if (projectedGrowthPercent > 7) {
        finalClassification = "stable";
        finalAdvice = "Hold the Stock (Forecast indicates growth)";
      } else {
        finalClassification = "unstable";
        finalAdvice = "Sell the Stock";
      }
    }

    const forecastEndDate = getMarketCloseTime();
    const stockName = stock.price?.longName || symbol;
    const stockRevenueGrowth =
      stockIndustry !== "Unknown" &&
      industryMetrics[stockIndustry] &&
      industryMetrics[stockIndustry].revenueGrowth
        ? industryMetrics[stockIndustry].revenueGrowth
        : 0;

    return res.json({
      symbol,
      name: stockName,
      industry: stockIndustry,
      fundamentalRating: +fundamentalRating.toFixed(2),
      combinedScore: numericCombinedScore,
      classification: finalClassification,
      advice: finalAdvice,
      metrics: {
        ...metrics,
        dayRange: metrics.dayHigh - metrics.dayLow,
        fiftyTwoWeekRange: metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow,
      },
      forecast: {
        forecastPrice: +finalForecastPrice.toFixed(2),
        projectedGrowthPercent: projectedGrowthPercent.toFixed(2) + "%",
        forecastPeriod: "End of Day",
        forecastEndDate: forecastEndDate.toISOString(),
      },
      revenueGrowth: stockRevenueGrowth,
    });
  } catch (error) {
    console.error("❌ Error in /api/check-stock:", error.message);
    return res.status(500).json({ message: "Error fetching stock data.", error: error.message });
  }
});

/****************************************************
 * HELPER: classifyStockForBuy(symbol)
 * Used by the Finder to see if a stock is 'growth' or 'stable' or 'unstable'
 * (No forecast model is used here)
 ****************************************************/
async function classifyStockForBuy(symbol) {
  // fetch data & skip if error
  const stock = await fetchStockData(symbol);
  if (!stock || !stock.price) {
    throw new Error(`No price data for symbol ${symbol}`);
  }

  const computedAvgVolume =
    stock.summaryDetail?.averageDailyVolume3Month || stock.price?.regularMarketVolume || 0;
  let score = 0;
  const metrics = {
    volume: stock.price?.regularMarketVolume ?? 0,
    currentPrice: stock.price?.regularMarketPrice ?? 0,
    peRatio: stock.summaryDetail?.trailingPE ?? 0,
    earningsGrowth: stock.financialData?.earningsGrowth ?? 0,
    debtRatio: stock.financialData?.debtToEquity ?? 0,
    dayHigh: stock.price?.regularMarketDayHigh ?? 0,
    dayLow: stock.price?.regularMarketDayLow ?? 0,
    fiftyTwoWeekHigh: stock.summaryDetail?.fiftyTwoWeekHigh ?? 0,
    fiftyTwoWeekLow: stock.summaryDetail?.fiftyTwoWeekLow ?? 0,
  };

  // A quick scoring based solely on fundamentals
  if (metrics.volume > computedAvgVolume * 1.2) score += 3;
  else if (metrics.volume < computedAvgVolume * 0.8) score -= 2;
  if (metrics.peRatio >= 5 && metrics.peRatio <= 20) score += 2;
  else if (metrics.peRatio > 40) score -= 2;
  if (metrics.earningsGrowth > 0.2) score += 4;
  else if (metrics.earningsGrowth > 0.05) score += 2;
  else if (metrics.earningsGrowth < 0) score -= 2;
  if (metrics.debtRatio < 0.3) score += 3;
  else if (metrics.debtRatio > 1) score -= 2;

  // 52-week position
  const weekRange = metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow;
  if (weekRange > 0) {
    const pos = (metrics.currentPrice - metrics.fiftyTwoWeekLow) / weekRange;
    if (pos < 0.3) score += 2;
    else if (pos > 0.8) score -= 2;
  }

  console.log(`[classifyStockForBuy] Symbol=${symbol}, score=${score}`);
  let classification;
  if (score >= 8) classification = "growth";
  else if (score >= 0) classification = "stable";
  else classification = "unstable";

  return { classification };
}

/* --- Finder Endpoints --- */
const finderRouter = express.Router();
finderRouter.post("/api/find-stocks", async (req, res) => {
  try {
    const { stockType, exchange, minPrice, maxPrice } = req.body;
    if (!stockType || !exchange || typeof minPrice !== "number" || typeof maxPrice !== "number") {
      return res.status(400).json({ message: "Invalid finder parameters." });
    }
    const filtered = [];
    // We'll use allStocks from the loaded JSON
    for (const s of allStocks) {
      if (s.exchange && s.exchange !== exchange) continue;
      try {
        const data = await fetchStockData(s.symbol);
        const currentPrice = data?.price?.regularMarketPrice;
        if (!currentPrice) continue;
        if (currentPrice < minPrice || currentPrice > maxPrice) continue;
        // Classify for buy using only fundamental criteria (forecasting is not applied here)
        const { classification } = await classifyStockForBuy(s.symbol);
        // If user wants "growth" only, skip stable/unstable
        if (stockType === "growth" && classification !== "growth") continue;
        // If user wants "stable" only, skip growth/unstable
        if (stockType === "stable" && classification !== "stable") continue;
        filtered.push({ symbol: s.symbol, exchange: s.exchange || "N/A" });
      } catch (err) {
        console.warn(`Finder: skipping ${s.symbol} due to error: ${err.message}`);
        continue;
      }
    }
    return res.json({ stocks: filtered });
  } catch (error) {
    console.error("Finder error:", error.message);
    return res.status(500).json({ message: "Error finding stocks." });
  }
});
finderRouter.post("/signup", async (req, res) => {
  // you can omit or replicate your /signup logic
  return res.json({ message: "Signup from finder not used." });
});
finderRouter.post("/login", async (req, res) => {
  // you can omit or replicate your /login logic
  return res.json({ message: "Login from finder not used." });
});
app.use("/finder", finderRouter);

// --- Popular Stocks Endpoint (placeholder) ---
let popularStocksCache = null;
let popularStocksCacheTimestamp = 0;
const POPULAR_CACHE_DURATION = 5 * 60 * 1000;
app.get("/api/popular-stocks", async (req, res) => {
  // placeholder
  return res.json({ message: "Popular stocks not fully implemented." });
});

// --- Stock Forecasting Endpoint (placeholder) ---
app.post("/api/forecast-stock", async (req, res) => {
  return res.json({ message: "Forecast-stock not fully implemented." });
});

// --- Community Endpoints ---
app.get("/api/community-posts", async (req, res) => {
  try {
    const posts = await CommunityPost.find().sort({ createdAt: -1 });
    return res.json({ posts });
  } catch (err) {
    console.error("Error fetching community posts:", err.message);
    return res.status(500).json({ message: "Error fetching community posts." });
  }
});
app.post("/api/community-posts", async (req, res) => {
  const { username, message } = req.body;
  if (!username || !message) {
    return res.status(400).json({ message: "Username and message are required." });
  }
  try {
    const newPost = new CommunityPost({ username, message });
    await newPost.save();
    return res.status(201).json({ message: "Post created successfully." });
  } catch (error) {
    console.error("Error creating post:", error.message);
    return res.status(500).json({ message: "Error creating post." });
  }
});

// --- Notifications Endpoint ---
app.get("/api/notifications", (req, res) => {
  return res.json({ notifications: [] });
});

/*******************************************
 * AUTOMATED INVESTOR SECTION (UPDATED)
 *******************************************/
const STOCKS_JSON = path.join(__dirname, "symbols.json");
const PORTFOLIO_JSON = path.join(__dirname, "portfolio.json");

// Master array of all stocks from symbols.json
let allStocks = [];
if (fs.existsSync(STOCKS_JSON)) {
  try {
    const rawContent = fs.readFileSync(STOCKS_JSON, "utf-8");
    allStocks = JSON.parse(rawContent);
    console.log(`✅ Loaded ${allStocks.length} stocks from symbols.json`);
  } catch (err) {
    console.error("Error parsing symbols.json:", err);
    allStocks = [];
  }
} else {
  console.warn("⚠️  No symbols.json found. Automated investor will skip buying.");
}

// Portfolio
let portfolio = fs.existsSync(PORTFOLIO_JSON)
  ? JSON.parse(fs.readFileSync(PORTFOLIO_JSON, "utf-8"))
  : [];
function savePortfolio() {
  fs.writeFileSync(PORTFOLIO_JSON, JSON.stringify(portfolio, null, 2));
}

// Filter function for auto investor
async function getFilteredSymbols(stockType, exchange, minPrice, maxPrice) {
  const filteredSymbols = [];
  const batchSize = 10;
  for (let i = 0; i < allStocks.length; i += batchSize) {
    const batch = allStocks.slice(i, i + batchSize);
    for (const s of batch) {
      if (s.exchange && s.exchange !== exchange) continue;
      try {
        const data = await fetchStockData(s.symbol);
        const currentPrice = data?.price?.regularMarketPrice;
        if (!currentPrice) continue;
        if (currentPrice < minPrice || currentPrice > maxPrice) continue;
        filteredSymbols.push(s.symbol);
      } catch (err) {
        console.error(`Filtering: Skipping ${s.symbol} due to error:`, err.message);
        continue;
      }
    }
    await delay(1000);
  }
  console.log(`Filtered symbols count: ${filteredSymbols.length}`);
  return filteredSymbols;
}

async function autoBuyStocks() {
  if (!isMarketOpen()) return;
  const stockType = "growth";
  const exchange = "NASDAQ";
  const minPrice = 10;
  const maxPrice = 100;
  const filteredSymbols = await getFilteredSymbols(stockType, exchange, minPrice, maxPrice);
  for (const symbol of filteredSymbols) {
    try {
      // Insert advanced logic if desired
      console.log(`autoBuyStocks would analyze ${symbol} here...`);
    } catch (error) {
      console.error(`Error analyzing stock ${symbol}:`, error.message);
    }
  }
}

async function autoSellStocks() {
  if (!isMarketOpen()) return;
  // your autoSell logic here
}

// Automated tasks
setInterval(async () => {
  try {
    await autoBuyStocks();
    await autoSellStocks();
  } catch (err) {
    console.error("Error running automated investor tasks:", err.message);
  }
}, 60_000);

// Simulation Endpoint
app.get("/api/simulate-trades", async (req, res) => {
  try {
    let simulatedPortfolio = JSON.parse(JSON.stringify(portfolio));
    let simulationLog = [];
    const stockType = "growth";
    const exchange = "NASDAQ";
    const minPrice = 10;
    const maxPrice = 100;
    const filteredSymbols = await getFilteredSymbols(stockType, exchange, minPrice, maxPrice);
    for (const symbol of filteredSymbols) {
      try {
        console.log(`Simulating buy for symbol: ${symbol}`);
        const data = await fetchStockData(symbol);
        if (!data || !data.price) continue;
        // Quick check logic
        let rating = 0;
        const avgVol = data.summaryDetail?.averageDailyVolume3Month || data.price?.regularMarketVolume || 0;
        const currPrice = data.price?.regularMarketPrice || 0;
        if (data.price?.regularMarketVolume > avgVol * 1.2) rating += 3;
        if (currPrice < 100) rating += 2;
        if (rating >= 2 && currPrice < 100) {
          simulationLog.push(`Simulated Buy: ${symbol} at $${currPrice} (Rating: ${rating})`);
          simulatedPortfolio.push({
            symbol,
            buyPrice: currPrice,
            quantity: 10,
            buyDate: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error(`Simulation: Skipping ${symbol} due to error: ${err.message}`);
        continue;
      }
    }
    return res.json({
      message: "Simulation complete.",
      simulationLog,
      simulatedPortfolio,
    });
  } catch (error) {
    console.error("Simulation error:", error.message);
    return res.status(500).json({ message: "Simulation error.", error: error.message });
  }
});

/*******************************************
 * OPTIONAL: EXECUTE-TRADE ENDPOINT
 *******************************************/
app.post("/api/execute-trade", async (req, res) => {
  const { symbol, quantity, action } = req.body;
  try {
    // If you have an investopediaTrader module, call it
    // e.g.:
    // const { placeTrade } = require('./investopediaTrader');
    // await placeTrade({
    //   username: process.env.INVESTOPEDIA_USER,
    //   symbol,
    //   quantity,
    //   action,
    // });
    res.json({ message: `Trade executed: ${action} ${quantity} shares of ${symbol}` });
  } catch (error) {
    console.error("Trade execution error:", error.message);
    res.status(500).json({ message: "Trade execution failed", error: error.message });
  }
});

/*******************************************
 * 7. START THE SERVER
 *******************************************/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

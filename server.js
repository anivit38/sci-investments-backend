/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, FORECASTING, COMMUNITY
 *******************************************/

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

// ────────────────────────────────────────────────────────────
//  1) fetchData Helpers
// ────────────────────────────────────────────────────────────
const {
  loadCsvIntoMemory,
  getCachedHistoricalData,
  fetchAllSymbolsHistoricalData,
} = require("./fetchData");

// On Startup: Load CSV data into memory
loadCsvIntoMemory();

// ────────────────────────────────────────────────────────────
//  2) Nodemailer Setup (Optional)
// ────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.NOTIFY_EMAIL,
    pass: process.env.NOTIFY_PASSWORD,
  },
});
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

// ────────────────────────────────────────────────────────────
//  3) Utility Helpers
// ────────────────────────────────────────────────────────────
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Check if the market is open (NYSE hours: M–F, 9:30–16:00 ET)
function isMarketOpen() {
  const now = new Date();
  const options = { timeZone: "America/New_York", hour12: false };
  const estString = now.toLocaleString("en-US", options);
  const est = new Date(estString);
  const day = est.getDay(); // 0=Sun,6=Sat
  if (day === 0 || day === 6) return false;
  const hour = est.getHours();
  const minute = est.getMinutes();
  if (hour < 9 || (hour === 9 && minute < 30)) return false;
  if (hour > 16 || (hour === 16 && minute > 0)) return false;
  return true;
}

/**
 * getForecastEndTime():
 *   If market is open, returns today's 4:00 PM ET.
 *   Else returns next business day's 4:00 PM ET.
 */
function getForecastEndTime() {
  const now = new Date();
  const etNow = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  if (isMarketOpen()) {
    etNow.setHours(16, 0, 0, 0);
    return etNow;
  } else {
    let next = new Date(etNow);
    next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
    next.setHours(16, 0, 0, 0);
    return next;
  }
}

// yahooFinance request options
const requestOptions = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36",
  },
  redirect: "follow",
};

// ────────────────────────────────────────────────────────────
//  4) Mongoose Models & Setup
// ────────────────────────────────────────────────────────────
const UserModel = require(path.join(__dirname, "models", "User"));

const communityPostSchema = new mongoose.Schema({
  username: { type: String, required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const CommunityPost = mongoose.model("CommunityPost", communityPostSchema);

// 2.1) Load industry metrics
let industryMetrics = {};
try {
  industryMetrics = require("./industryMetrics.json");
} catch (err) {
  console.error("Error loading industryMetrics.json:", err.message);
}

// ────────────────────────────────────────────────────────────
//  5) Express App
// ────────────────────────────────────────────────────────────
const app = express();
app.use(
  cors({
    origin: "https://sci-investments.web.app", // or your domain
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);
app.options("*", cors());
app.use(bodyParser.json());

// ────────────────────────────────────────────────────────────
//  6) MongoDB Connection
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
//  7) Forecast Model Setup
// ────────────────────────────────────────────────────────────
let forecastModel = null;
let normalizationParams = null;

async function loadForecastResources() {
  try {
    const modelPath = "file://model/forecast_model/model.json";
    forecastModel = await tf.loadLayersModel(modelPath);
    console.log("✅ Forecast model loaded from", modelPath);

    const normPath = path.join(__dirname, "model", "forecast_model", "normalization.json");
    if (fs.existsSync(normPath)) {
      const normData = fs.readFileSync(normPath, "utf-8");
      normalizationParams = JSON.parse(normData);
      console.log("✅ Normalization parameters loaded.");
    } else {
      console.warn("⚠️ No normalization.json found. Advanced forecasting may be skipped.");
      normalizationParams = null;
    }
  } catch (error) {
    console.error("❌ Error loading forecast resources:", error.message);
    forecastModel = null;
    normalizationParams = null;
  }
}
loadForecastResources();

const forecastCache = {};
const FORECAST_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ────────────────────────────────────────────────────────────
//  8) Simple Forecast Fallback
// ────────────────────────────────────────────────────────────
async function simpleForecastPrice(symbol, currentPrice) {
  try {
    const historicalData = getCachedHistoricalData(symbol);
    if (!historicalData || historicalData.length < 5) {
      return currentPrice;
    }
    historicalData.sort((a, b) => new Date(a.date) - new Date(b.date));
    const recentData = historicalData.slice(-10);
    let sumPct = 0;
    let count = 0;
    for (const day of recentData) {
      if (day.open && day.close) {
        const pctChange = (day.close - day.open) / day.open;
        sumPct += pctChange;
        count++;
      }
    }
    const avgDailyReturn = count ? sumPct / count : 0;
    const forecast = currentPrice * (1 + avgDailyReturn);
    console.log(
      `Simple forecast for ${symbol}: currentPrice=${currentPrice}, avgDailyReturn=${(avgDailyReturn * 100).toFixed(2)}%, forecast=${forecast.toFixed(2)}`
    );
    return forecast;
  } catch (err) {
    console.error(`Error in simpleForecastPrice for ${symbol}:`, err.message);
    return currentPrice;
  }
}

// ────────────────────────────────────────────────────────────
//  9) Stock Data Caching for "quoteSummary"
// ────────────────────────────────────────────────────────────
const stockDataCache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * fetchStockData(symbol):
 *   - Returns cached data if fresh (or if market is closed).
 *   - Otherwise fetches from Yahoo and caches for 15 min.
 */
async function fetchStockData(symbol) {
  const now = Date.now();
  const marketOpen = isMarketOpen();

  // If market is closed, prefer existing cache to avoid repeated fetches
  if (!marketOpen && stockDataCache[symbol]) {
    console.log(`Market closed, using cached data for ${symbol}`);
    return stockDataCache[symbol].data;
  }

  // If we have cached data < 15 min old, use it
  if (stockDataCache[symbol] && now - stockDataCache[symbol].timestamp < CACHE_TTL) {
    console.log(`Using cached data for ${symbol}`);
    return stockDataCache[symbol].data;
  }

  // Otherwise, fetch fresh
  console.log(`Fetching fresh data for ${symbol}`);
  const modules = [
    "financialData",
    "price",
    "summaryDetail",
    "defaultKeyStatistics",
    "assetProfile",
  ];
  try {
    const data = await yahooFinance.quoteSummary(
      symbol,
      { modules, validateResult: false },
      { fetchOptions: requestOptions }
    );
    if (!data || !data.price) {
      throw new Error("Missing or invalid data from quoteSummary");
    }
    stockDataCache[symbol] = { data, timestamp: now };
    return data;
  } catch (err) {
    if (err.message.includes("Unexpected token")) {
      console.error(`❌ Possibly rate-limited or captcha from Yahoo for ${symbol}:`, err.message);
    } else {
      console.error(`❌ Error fetching data for ${symbol}:`, err.message);
    }
    return null;
  }
}

/**
 * fetchTimeSeriesData(symbol, days=30)
 * Return up to the last 'days' records from CSV memory.
 */
async function fetchTimeSeriesData(symbol, days = 30) {
  const historical = getCachedHistoricalData(symbol);
  if (!historical || historical.length === 0) {
    throw new Error(`No daily data available for ${symbol}.`);
  }
  historical.sort((a, b) => new Date(a.date) - new Date(b.date));
  return historical.slice(-days);
}

// ────────────────────────────────────────────────────────────
// 10) Historical Data for Charting (live route)
// ────────────────────────────────────────────────────────────
app.post("/api/stock-history", async (req, res) => {
  const { symbol, range } = req.body;
  if (!symbol) {
    return res.status(400).json({ message: "Stock symbol is required." });
  }
  let days;
  switch (range) {
    case "1d":
      days = 1;
      break;
    case "5d":
      days = 5;
      break;
    case "1w":
      days = 7;
      break;
    case "1m":
      days = 30;
      break;
    case "6m":
      days = 180;
      break;
    case "1y":
      days = 365;
      break;
    case "MAX":
      days = 1825;
      break;
    default:
      days = 30;
      break;
  }
  try {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    const historicalData = await yahooFinance.historical(
      symbol,
      { period1: startDate, period2: endDate, interval: "1d" },
      { fetchOptions: requestOptions }
    );
    if (!historicalData || historicalData.length === 0) {
      return res.status(404).json({ message: "No historical data found for this symbol." });
    }
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

// ────────────────────────────────────────────────────────────
// 11) Auth Endpoints
// ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("✅ Combined Server is running!"));

app.post("/signup", async (req, res) => {
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
  if (!token) return res.status(401).json({ message: "Unauthorized. Token required." });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.status(200).json({ message: "Protected data accessed.", user: decoded });
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

// ────────────────────────────────────────────────────────────
// 12) ADVANCED END-OF-DAY FORECASTING / STOCK CHECKER
//    (Now using forecastGrowthPercent solely for classification)
// ────────────────────────────────────────────────────────────
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent } = req.body;
  if (!symbol || !intent) {
    return res.status(400).json({ message: "Stock symbol and intent (buy/sell) are required." });
  }
  try {
    // 1) Fetch current fundamentals
    let stock;
    try {
      stock = await fetchStockData(symbol);
    } catch (innerErr) {
      console.error(`❌ Error fetching stock data for "${symbol}":`, innerErr.message);
      return res.status(500).json({ message: "Error fetching stock data." });
    }
    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }

    // 2) Calculate metrics for display (for info only)
    const computedAvgVolume = stock.summaryDetail?.averageDailyVolume3Month || stock.price?.regularMarketVolume || 0;
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

    // ────────────────────────────────────────────────────────
    // (A) Compute "fundamentalRating" for display (NOT used for classification)
    let baseScore = 0;
    if (metrics.volume > computedAvgVolume * 1.2) baseScore += 3;
    else if (metrics.volume < computedAvgVolume * 0.8) baseScore -= 2;
    if (metrics.peRatio >= 5 && metrics.peRatio <= 25) baseScore += 2;
    else if (metrics.peRatio > 30) baseScore -= 1;
    if (metrics.earningsGrowth > 0.15) baseScore += 4;
    else if (metrics.earningsGrowth > 0.03) baseScore += 2;
    else if (metrics.earningsGrowth < 0) baseScore -= 2;
    if (metrics.debtRatio < 0.3) baseScore += 3;
    else if (metrics.debtRatio > 1) baseScore -= 1;
    let dayScore = 0;
    const dayRange = metrics.dayHigh - metrics.dayLow;
    if (dayRange > 0) {
      const dayPos = (metrics.currentPrice - metrics.dayLow) / dayRange;
      if (dayPos < 0.2) dayScore = 1;
      else if (dayPos > 0.8) dayScore = -1;
    }
    let weekScore = 0;
    const weekRange = metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow;
    if (weekRange > 0) {
      const weekPos = (metrics.currentPrice - metrics.fiftyTwoWeekLow) / weekRange;
      if (weekPos < 0.3) weekScore = 2;
      else if (weekPos > 0.8) weekScore = -2;
    }
    let industryScore = 0;
    const stockIndustry = stock.assetProfile?.industry || stock.assetProfile?.sector || "Unknown";
    if (stockIndustry !== "Unknown" && industryMetrics[stockIndustry]) {
      const ind = industryMetrics[stockIndustry];
      if (metrics.peRatio && ind.peRatio) {
        industryScore += metrics.peRatio < ind.peRatio ? 2 : -2;
      }
      if (metrics.earningsGrowth && ind.revenueGrowth) {
        const stockEG = metrics.earningsGrowth * 100;
        industryScore += stockEG > ind.revenueGrowth ? 2 : -2;
      }
      if (metrics.debtRatio && ind.debtToEquity) {
        industryScore += metrics.debtRatio < ind.debtToEquity ? 2 : -2;
      }
    }
    const fundamentalRating = baseScore + dayScore + weekScore + industryScore;

    // ────────────────────────────────────────────────────────
    // (B) Advanced forecasting using last 30 trading days
    let advancedForecastPrice = null;
    let timeSeriesData;
    try {
      timeSeriesData = await fetchTimeSeriesData(symbol, 30);
    } catch (e) {
      console.warn(`⚠️ Not enough historical data for advanced forecasting for ${symbol}:`, e.message);
    }
    if (timeSeriesData && timeSeriesData.length === 30 && forecastModel && normalizationParams) {
      try {
        const featureKeys = ["open", "high", "low", "close", "volume", "peRatio", "earningsGrowth", "debtToEquity"];
        const sequence = timeSeriesData.map((day) =>
          featureKeys.map((k) => {
            const val = day[k] ?? 0;
            const { mean = 0, std = 1 } = normalizationParams[k] || {};
            return std !== 0 ? (val - mean) / std : 0;
          })
        );
        const inputTensor = tf.tensor3d([sequence], [1, 30, featureKeys.length]);
        console.log("Time-series input shape:", inputTensor.shape);
        const predictionTensor = forecastModel.predict(inputTensor);
        const predVal = predictionTensor.dataSync()[0];
        const closeStats = normalizationParams["close"] || { mean: 0, std: 1 };
        advancedForecastPrice = predVal * closeStats.std + closeStats.mean;
        console.log(`Advanced forecast for ${symbol}: ${advancedForecastPrice.toFixed(2)}`);
      } catch (tfErr) {
        console.error(`Model forecast error for ${symbol}:`, tfErr.message);
      }
    } else {
      console.log(
        `Advanced forecasting skipped for ${symbol} (data points: ${timeSeriesData ? timeSeriesData.length : 0}).`
      );
    }

    // ────────────────────────────────────────────────────────
    // (C) Fallback forecast if advanced forecast is not available
    let finalForecastPrice = null;
    const currentPrice = metrics.currentPrice;
    if (
      forecastCache[symbol] &&
      Date.now() - forecastCache[symbol].timestamp < FORECAST_CACHE_TTL
    ) {
      finalForecastPrice = forecastCache[symbol].price;
      console.log(`Using cached forecast for ${symbol}: ${finalForecastPrice}`);
    } else {
      if (!advancedForecastPrice || Math.abs(advancedForecastPrice - currentPrice) < 0.01) {
        finalForecastPrice = await simpleForecastPrice(symbol, currentPrice);
      } else {
        finalForecastPrice = advancedForecastPrice;
      }
      forecastCache[symbol] = { price: finalForecastPrice, timestamp: Date.now() };
    }

    // ────────────────────────────────────────────────────────
    // (D) Calculate forecast growth percentage
    const forecastGrowthPercent = ((finalForecastPrice - currentPrice) / currentPrice) * 100;

    // ────────────────────────────────────────────────────────
    // (E) Combined Score (for display only; not used for classification)
    const combinedScore = 0.2 * fundamentalRating + 0.8 * forecastGrowthPercent;

    // ────────────────────────────────────────────────────────
    // (F) Classification based solely on forecast growth percentage:
    //    - Growth: forecastGrowthPercent >= 2%
    //    - Stable: forecastGrowthPercent >= 0% but less than 2%
    //    - Unstable: forecastGrowthPercent < 0%
    let finalClassification, finalAdvice;
    if (forecastGrowthPercent >= 2) {
      finalClassification = "growth";
      finalAdvice = "This stock is projected to grow significantly. Consider buying.";
    } else if (forecastGrowthPercent >= 0) {
      finalClassification = "stable";
      finalAdvice = "This stock is projected to have minimal growth. It may be better suited as a stable holding.";
    } else {
      finalClassification = "unstable";
      finalAdvice = "This stock is projected to decline. Consider selling or avoiding.";
    }

    const forecastEndDate = getForecastEndTime();
    const stockName = stock.price?.longName || symbol;
    const stockRevenueGrowth =
      stockIndustry !== "Unknown" &&
      industryMetrics[stockIndustry] &&
      industryMetrics[stockIndustry].revenueGrowth
        ? industryMetrics[stockIndustry].revenueGrowth
        : 0;

    // Return the result
    return res.json({
      symbol,
      name: stockName,
      industry: stockIndustry,
      fundamentalRating: fundamentalRating.toFixed(2),
      combinedScore: combinedScore.toFixed(2),
      forecast: {
        forecastPrice: +finalForecastPrice.toFixed(2),
        projectedGrowthPercent: forecastGrowthPercent.toFixed(2) + "%",
        forecastPeriod: "End of Day",
        forecastEndDate: forecastEndDate.toISOString(),
      },
      classification: finalClassification,
      advice: finalAdvice,
      metrics: {
        ...metrics,
        dayRange: metrics.dayHigh - metrics.dayLow,
        fiftyTwoWeekRange: metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow,
      },
      revenueGrowth: stockRevenueGrowth,
    });
  } catch (error) {
    console.error("❌ Error in /api/check-stock:", error.message);
    return res.status(500).json({ message: "Error fetching stock data.", error: error.message });
  }
});

// ────────────────────────────────────────────────────────────
// 13) Forecast-based classification for Finder
//     (Classification now uses forecast growth only)
// ────────────────────────────────────────────────────────────
async function classifyStockByForecast(symbol) {
  const data = await fetchStockData(symbol);
  if (!data || !data.price) {
    throw new Error(`No price data for symbol ${symbol}`);
  }
  const currentPrice = data.price.regularMarketPrice ?? 0;

  let finalForecastPrice = null;
  if (
    forecastCache[symbol] &&
    Date.now() - forecastCache[symbol].timestamp < FORECAST_CACHE_TTL
  ) {
    finalForecastPrice = forecastCache[symbol].price;
  } else {
    let advancedForecastPrice = null;
    let timeSeriesData;
    try {
      timeSeriesData = await fetchTimeSeriesData(symbol, 30);
    } catch {
      // not enough data
    }
    if (timeSeriesData && timeSeriesData.length === 30 && forecastModel && normalizationParams) {
      try {
        const featureKeys = ["open", "high", "low", "close", "volume", "peRatio", "earningsGrowth", "debtToEquity"];
        const sequence = timeSeriesData.map((day) =>
          featureKeys.map((k) => {
            const val = day[k] ?? 0;
            const { mean = 0, std = 1 } = normalizationParams[k] || {};
            return std !== 0 ? (val - mean) / std : 0;
          })
        );
        const inputTensor = tf.tensor3d([sequence], [1, 30, featureKeys.length]);
        const predictionTensor = forecastModel.predict(inputTensor);
        const predVal = predictionTensor.dataSync()[0];
        const closeStats = normalizationParams["close"] || { mean: 0, std: 1 };
        advancedForecastPrice = predVal * closeStats.std + closeStats.mean;
      } catch {
        // advanced forecast error
      }
    }
    if (advancedForecastPrice && Math.abs(advancedForecastPrice - currentPrice) > 0.01) {
      finalForecastPrice = advancedForecastPrice;
    } else {
      finalForecastPrice = await simpleForecastPrice(symbol, currentPrice);
    }
    forecastCache[symbol] = { price: finalForecastPrice, timestamp: Date.now() };
  }

  if (!finalForecastPrice || !currentPrice || currentPrice <= 0) {
    return { classification: "unstable" };
  }
  const forecastGrowthPercent = ((finalForecastPrice - currentPrice) / currentPrice) * 100;
  if (forecastGrowthPercent >= 2) return { classification: "growth" };
  if (forecastGrowthPercent >= 0) return { classification: "stable" };
  return { classification: "unstable" };
}

const finderRouter = express.Router();
finderRouter.post("/api/find-stocks", async (req, res) => {
  try {
    let { stockType, exchange, minPrice, maxPrice } = req.body;
    if (typeof stockType === "string") stockType = stockType.toLowerCase();
    if (typeof exchange === "string") exchange = exchange.toUpperCase();
    if (!stockType || !exchange || typeof minPrice !== "number" || typeof maxPrice !== "number") {
      return res.status(400).json({ message: "Invalid finder parameters." });
    }

    const filtered = [];
    for (const s of allStocks) {
      const sym = typeof s === "string" ? s : s.symbol;
      const exch = typeof s === "string" ? "N/A" : s.exchange || "N/A";
      if (exch.toUpperCase() !== exchange) continue;

      let data = null;
      try {
        data = await fetchStockData(sym);
      } catch (err) {
        console.warn(`Finder: skipping ${sym} due to fetch error: ${err.message}`);
        continue;
      }
      if (!data || !data.price) {
        console.warn(`Finder: skipping ${sym} (no data.price)`);
        continue;
      }
      const currentPrice = data.price.regularMarketPrice;
      if (!currentPrice) continue;
      if (currentPrice < minPrice || currentPrice > maxPrice) continue;

      // Classify by forecast
      try {
        const { classification } = await classifyStockByForecast(sym);
        if (classification !== stockType) {
          continue;
        }
        filtered.push({ symbol: sym, exchange: exch });
      } catch (err) {
        console.warn(`Finder classification error for ${sym}: ${err.message}`);
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
  return res.json({ message: "Signup from finder not used." });
});
finderRouter.post("/login", async (req, res) => {
  return res.json({ message: "Login from finder not used." });
});
app.use("/finder", finderRouter);

// ────────────────────────────────────────────────────────────
// 15) Other endpoints (Popular Stocks, Forecast-stock, etc.)
// ────────────────────────────────────────────────────────────
app.get("/api/popular-stocks", async (req, res) => {
  return res.json({ message: "Popular stocks not fully implemented." });
});

app.post("/api/forecast-stock", async (req, res) => {
  return res.json({ message: "Forecast-stock not fully implemented." });
});

// ────────────────────────────────────────────────────────────
// 16) Community Endpoints
// ────────────────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────────
// 17) Notifications Endpoint (Placeholder)
// ────────────────────────────────────────────────────────────
app.get("/api/notifications", (req, res) => {
  return res.json({ notifications: [] });
});

// ────────────────────────────────────────────────────────────
// 18) AUTOMATED INVESTOR SECTION
// ────────────────────────────────────────────────────────────
const SYMBOLS_JSON_PATH = path.join(__dirname, "symbols.json");
const PORTFOLIO_JSON_PATH = path.join(__dirname, "portfolio.json");

let allStocks = [];
if (fs.existsSync(SYMBOLS_JSON_PATH)) {
  try {
    const rawContent = fs.readFileSync(SYMBOLS_JSON_PATH, "utf-8");
    allStocks = JSON.parse(rawContent);
    console.log(`✅ Loaded ${allStocks.length} stocks from symbols.json`);
  } catch (err) {
    console.error("Error parsing symbols.json:", err);
    allStocks = [];
  }
} else {
  console.warn("⚠️ No symbols.json found. Automated investor will skip buying.");
}

let portfolio = fs.existsSync(PORTFOLIO_JSON_PATH)
  ? JSON.parse(fs.readFileSync(PORTFOLIO_JSON_PATH, "utf-8"))
  : [];
function savePortfolio() {
  fs.writeFileSync(PORTFOLIO_JSON_PATH, JSON.stringify(portfolio, null, 2));
}

async function getFilteredSymbols(stockType, exchange, minPrice, maxPrice) {
  const filteredSymbols = [];
  const batchSize = 10;
  for (let i = 0; i < allStocks.length; i += batchSize) {
    const batch = allStocks.slice(i, i + batchSize);
    for (const s of batch) {
      const symbol = typeof s === "string" ? s : s.symbol;
      if (s.exchange && s.exchange !== exchange) continue;
      try {
        const data = await fetchStockData(symbol);
        if (!data) {
          console.error(`Filtering: Skipping ${symbol} due to error or null data`);
          continue;
        }
        const currentPrice = data?.price?.regularMarketPrice;
        if (!currentPrice) continue;
        if (currentPrice < minPrice || currentPrice > maxPrice) continue;
        filteredSymbols.push(symbol);
      } catch (err) {
        console.error(`Filtering: Skipping ${symbol} due to error:`, err.message);
        continue;
      }
    }
    await delay(5000);
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
      console.log(`autoBuyStocks would analyze ${symbol} here...`);
      // Additional logic or forecasting calls if desired
    } catch (error) {
      console.error(`Error analyzing stock ${symbol}:`, error.message);
    }
  }
}

async function autoSellStocks() {
  if (!isMarketOpen()) return;
  // Implement your autoSell logic here
}

setInterval(async () => {
  try {
    await autoBuyStocks();
    await autoSellStocks();
  } catch (err) {
    console.error("Error running automated investor tasks:", err.message);
  }
}, 60_000);

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

app.post("/api/execute-trade", async (req, res) => {
  const { symbol, quantity, action } = req.body;
  try {
    res.json({ message: `Trade executed: ${action} ${quantity} shares of ${symbol}` });
  } catch (error) {
    console.error("Trade execution error:", error.message);
    res.status(500).json({ message: "Trade execution failed", error: error.message });
  }
});

// ────────────────────────────────────────────────────────────
// 18) Daily Job: Refresh All Historical Data
// ────────────────────────────────────────────────────────────
const ONE_DAY = 24 * 60 * 60 * 1000;
async function refreshAllHistoricalData() {
  try {
    if (!fs.existsSync(SYMBOLS_JSON_PATH)) {
      console.log("No symbols.json found, skipping daily historical fetch.");
      return;
    }
    const raw = fs.readFileSync(SYMBOLS_JSON_PATH, "utf-8");
    const symbols = JSON.parse(raw);
    await fetchAllSymbolsHistoricalData(symbols, 1);
    // Optionally, update CSV here
  } catch (err) {
    console.error("Error in refreshAllHistoricalData:", err.message);
  }
}
refreshAllHistoricalData();
setInterval(() => {
  console.log("⏰ Running daily refreshAllHistoricalData...");
  refreshAllHistoricalData();
}, ONE_DAY);

// ────────────────────────────────────────────────────────────
// 19) Start the Server
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

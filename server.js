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

// CommunityPost Model for the community page
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

/**
 * Updated CORS configuration to ensure "Access-Control-Allow-Origin" is present.
 * Also allow standard methods/headers, plus handle OPTIONS requests.
 */
app.use(
  cors({
    origin: "https://sci-investments.web.app",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  })
);
// Handle preflight for all routes
app.options("*", cors());

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
const stockDataCache = {};
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
      {
        period1: startDate,
        period2: endDate,
        interval: "1d",
      },
      { fetchOptions: requestOptions }
    );
    if (!historicalData || historicalData.length === 0) {
      return res
        .status(404)
        .json({ message: "No historical data found for this symbol." });
    }
    // Sort ascending
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
    return res
      .status(500)
      .json({ message: "Error fetching historical data." });
  }
});

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
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "Username and password are required." });
  }
  try {
    const user = await UserModel.findOne({ username });
    if (!user)
      return res.status(401).json({ message: "Invalid credentials." });
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      return res.status(401).json({ message: "Invalid credentials." });
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      {
        expiresIn: "24h",
      }
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
    return res.status(200).json({
      message: "Protected data accessed.",
      user: decoded,
    });
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

// --- Stock Checker Endpoint (Industry, Forecasting, News Sentiment) ---
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent } = req.body;
  if (!symbol || !intent) {
    return res
      .status(400)
      .json({ message: "Stock symbol and intent (buy/sell) are required." });
  }
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
    if (!stock || !stock.price) {
      return res
        .status(404)
        .json({ message: "Stock not found or data unavailable." });
    }

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
      const dayPosition =
        (metrics.currentPrice - metrics.dayLow) / dayRange;
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
        industryScore += metrics.peRatio < indMetrics.peRatio ? 2 : -2;
      }
      if (metrics.earningsGrowth && indMetrics.revenueGrowth) {
        industryScore +=
          metrics.earningsGrowth * 100 > indMetrics.revenueGrowth
            ? 2
            : -2;
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
    const bonus = metrics.dayLow && metrics.dayHigh && ( (metrics.dayHigh - metrics.dayLow) > 0 )
      ? ((metrics.currentPrice - metrics.dayLow) / (metrics.dayHigh - metrics.dayLow) < 0.3 ? 0.02 : -0.02)
      : 0;

    // Alternatively, as your code had it:
    // const bonus = dayScore > 0 ? 0.02 : -0.02;

    const fundamentalForecast =
      metrics.currentPrice *
      (1 + (metrics.earningsGrowth + industryGrowthFraction) / 2 + bonus);

    let historicalForecast = fundamentalForecast;
    try {
      const historicalData = await yahooFinance.historical(
        symbol,
        {
          period: "1y",
          interval: "1d",
        },
        { fetchOptions: requestOptions }
      );
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
        // Approx. 22 trading days in a month
        historicalForecast =
          metrics.currentPrice * (1 + avgDailyReturn * 22);
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

    // Adjust forecast using news sentiment
    const newsSentiment = await fetchStockNews(symbol);
    const sentimentAdjustment = newsSentiment * 0.005 * metrics.currentPrice;
    combinedForecast += sentimentAdjustment;

    const projectedGrowthPercent =
      ((combinedForecast - metrics.currentPrice) / metrics.currentPrice) * 100;
    const fundamentalRating = baseScore + dayScore + weekScore + industryScore;
    const rawCombinedScore = fundamentalRating + projectedGrowthPercent;
    const numericCombinedScore = +rawCombinedScore.toFixed(2);

    let finalClassification, finalAdvice;
    if (intent === "buy") {
      if (numericCombinedScore >= 40) {
        finalClassification = "growth";
        finalAdvice = "Very Good Stock to Buy";
      } else if (numericCombinedScore >= 20) {
        finalClassification = "growth";
        finalAdvice = "Good Stock to Buy";
      } else if (numericCombinedScore >= 0) {
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

    let stockRevenueGrowth = 0;
    if (
      stockIndustry !== "Unknown" &&
      industryMetrics[stockIndustry] &&
      industryMetrics[stockIndustry].revenueGrowth
    ) {
      stockRevenueGrowth = industryMetrics[stockIndustry].revenueGrowth;
    }

    const stockName = stock.price?.longName || symbol;

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
        forecastPrice: +combinedForecast.toFixed(2),
        projectedGrowthPercent: projectedGrowthPercent.toFixed(2) + "%",
        forecastPeriod: "1 month",
        forecastEndDate: forecastEndDate.toISOString(),
      },
      revenueGrowth: stockRevenueGrowth,
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

/**
 * IMPLEMENTATION of the Finder route
 * This is critical to fix "Failed to fetch" and CORS issues for /finder/api/find-stocks
 */
finderRouter.post("/api/find-stocks", async (req, res) => {
  try {
    const { stockType, exchange, minPrice, maxPrice } = req.body;

    // Basic validation
    if (
      !stockType ||
      !exchange ||
      typeof minPrice !== "number" ||
      typeof maxPrice !== "number"
    ) {
      return res
        .status(400)
        .json({ message: "Invalid finder parameters." });
    }

    // 1. Filter your stockList by exchange & price range
    const filtered = [];
    for (const s of stockList) {
      // If your symbols.json has { symbol: "AAPL", exchange: "NASDAQ" }
      // check the exchange if it matches
      if (s.exchange && s.exchange !== exchange) continue;

      // Optionally incorporate "stockType" logic here if desired.
      // For now, we skip that part and do a price check:
      try {
        const data = await fetchStockData(s.symbol);
        const currentPrice = data?.price?.regularMarketPrice;
        if (!currentPrice) continue;
        if (currentPrice >= minPrice && currentPrice <= maxPrice) {
          filtered.push({ symbol: s.symbol, exchange: s.exchange || "N/A" });
        }
      } catch (err) {
        console.warn(
          `Finder: skipping ${s.symbol} due to error: ${err.message}`
        );
        continue;
      }
    }

    // 2. Return the filtered list
    return res.json({ stocks: filtered });
  } catch (error) {
    console.error("Finder error:", error.message);
    return res.status(500).json({ message: "Error finding stocks." });
  }
});

// Keep the existing signup/login if you want them on the finder router
finderRouter.post("/signup", async (req, res) => {
  // ... unchanged ...
});
finderRouter.post("/login", async (req, res) => {
  // ... unchanged ...
});

app.use("/finder", finderRouter);

// --- Popular Stocks Endpoint with Caching ---
let popularStocksCache = null;
let popularStocksCacheTimestamp = 0;
const POPULAR_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
app.get("/api/popular-stocks", async (req, res) => {
  // ... unchanged ...
});

// --- Stock Forecasting Endpoint with News Sentiment Adjustment ---
app.post("/api/forecast-stock", async (req, res) => {
  // ... unchanged ...
});

// --- Community Endpoints ---
app.get("/api/community-posts", async (req, res) => {
  // ... unchanged ...
});
app.post("/api/community-posts", async (req, res) => {
  // ... unchanged ...
});

// --- Notifications Endpoint ---
app.get("/api/notifications", (req, res) => {
  // ... unchanged ...
});

/*******************************************
 * 6. AUTOMATED INVESTOR SECTION (UPDATED WITH FILTERS)
 *******************************************/

// File paths for stocks and portfolio data
const STOCKS_JSON = path.join(__dirname, "symbols.json");
const PORTFOLIO_JSON = path.join(__dirname, "portfolio.json");

// Load stock list (assumed to be a flattened array, e.g. [ { "symbol": "AAPL", "exchange": "NASDAQ" }, ... ])
let stockList = [];
if (fs.existsSync(STOCKS_JSON)) {
  try {
    const rawContent = fs.readFileSync(STOCKS_JSON, "utf-8");
    stockList = JSON.parse(rawContent);
    console.log(`✅ Loaded ${stockList.length} stocks from symbols.json`);
  } catch (err) {
    console.error("Error parsing symbols.json:", err);
    stockList = [];
  }
} else {
  console.warn("⚠️  No symbols.json found. Automated investor will skip buying.");
}

// Read or initialize portfolio.
let portfolio = fs.existsSync(PORTFOLIO_JSON)
  ? JSON.parse(fs.readFileSync(PORTFOLIO_JSON, "utf-8"))
  : [];

// Save portfolio to file
function savePortfolio() {
  fs.writeFileSync(PORTFOLIO_JSON, JSON.stringify(portfolio, null, 2));
}

/**
 * Example: Filter the stock list by exchange and price range.
 * Add "stockType" logic if desired. Right now, we only do exchange + price check.
 */
async function getFilteredSymbols(stockType, exchange, minPrice, maxPrice) {
  const filteredSymbols = [];
  const batchSize = 10;

  // Process in batches to avoid rate limits
  for (let i = 0; i < stockList.length; i += batchSize) {
    const batch = stockList.slice(i, i + batchSize);
    for (const s of batch) {
      if (s.exchange && s.exchange !== exchange) continue;
      try {
        const data = await fetchStockData(s.symbol);
        const currentPrice = data?.price?.regularMarketPrice;
        if (!currentPrice) continue;
        if (currentPrice < minPrice || currentPrice > maxPrice) continue;
        filteredSymbols.push(s.symbol);
      } catch (err) {
        console.error(
          `Filtering: Skipping ${s.symbol} due to error:`,
          err.message
        );
        continue;
      }
    }
    await delay(1000); // delay between each batch of 10
  }

  console.log(`Filtered symbols count: ${filteredSymbols.length}`);
  return filteredSymbols;
}

// This is your "check-stock" logic. We'll assume it's in scope as "analyzeStock" if you need it.
// Or you can rename your check-stock logic to reuse it for autoBuy. 
// (In your original code, you had 'analyzeStock' or used the logic inline. 
//  We'll skip rewriting that here for brevity, as it's presumably done above.)

// Example: autoBuyStocks (with filtering)
async function autoBuyStocks() {
  if (!isMarketOpen()) return;

  // Filter criteria
  const stockType = "growth";
  const exchange = "NASDAQ";
  const minPrice = 10;
  const maxPrice = 100;

  const filteredSymbols = await getFilteredSymbols(
    stockType,
    exchange,
    minPrice,
    maxPrice
  );

  for (const symbol of filteredSymbols) {
    try {
      // In your code, you might do 'const analysis = await analyzeStock(symbol);'
      // and then if (analysis.combinedScore >= 20) { buy... }
      // We'll skip the details for brevity:
      console.log(`autoBuyStocks would analyze ${symbol} here...`);
    } catch (error) {
      console.error(`Error analyzing stock ${symbol}:`, error.message);
    }
  }
}

// autoSellStocks is unchanged. We'll assume you have it with 'evaluateSellSignal', etc.
async function autoSellStocks() {
  if (!isMarketOpen()) return;
  // ...
}

// Periodic task
setInterval(async () => {
  try {
    await autoBuyStocks();
    await autoSellStocks();
  } catch (err) {
    console.error("Error running automated investor tasks:", err.message);
  }
}, 60_000);

// --- Simulation Endpoint for Automated Investor Trades (Secret) ---
app.get("/api/simulate-trades", async (req, res) => {
  try {
    // ...
    return res.json({
      message: "Simulation complete.",
      simulationLog: [],
      simulatedPortfolio: [],
    });
  } catch (error) {
    console.error("Simulation error:", error.message);
    return res
      .status(500)
      .json({ message: "Simulation error.", error: error.message });
  }
});

/*******************************************
 * 7. START THE SERVER
 *******************************************/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

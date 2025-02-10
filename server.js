/*******************************************
 * COMBINED SERVER FOR AUTH + STOCK CHECKER
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

// 1.1 Helper function: Delay (in milliseconds)
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 2. Models & External APIs
const UserModel = require(path.join(__dirname, "models", "User"));
const yahooFinance = require("yahoo-finance2").default;

// 3. Create a Single Express App
const app = express();
app.use(cors());
app.use(bodyParser.json());

// 4. Connect to MongoDB (only once)
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

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret"; // Use a real secret in production!

/******************************************************
 * SECTION A: Auth Endpoints (from auth-server.js)
 ******************************************************/
// Health check route
app.get("/", (req, res) => {
  res.send("✅ Combined Server is running!");
});

// Signup
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

// Login w/ JWT
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
    // Generate JWT
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

// Example Protected route
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
  // Expect symbol and intent in the body.
  const { symbol, intent } = req.body;
  if (!symbol || !intent) {
    return res.status(400).json({ message: "Stock symbol and intent (buy/sell) are required." });
  }
  try {
    // Request assetProfile along with other modules to obtain industry info.
    const stock = await yahooFinance.quoteSummary(symbol, {
      modules: [
        "financialData",
        "price",
        "summaryDetail",
        "defaultKeyStatistics",
        "assetProfile"
      ],
      validate: false, // Disable schema validation
    });
    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }
    // Compute average volume.
    const computedAvgVolume =
      stock.summaryDetail?.averageDailyVolume3Month ||
      stock.price?.regularMarketVolume ||
      0;
    // Build base metrics.
    const metrics = {
      volume: stock.price?.regularMarketVolume ?? 0,
      currentPrice: stock.price?.regularMarketPrice ?? 0,
      peRatio: stock.summaryDetail?.trailingPE ?? 0,
      pbRatio: stock.summaryDetail?.priceToBook ?? 0,         // Optional: remove if undesired
      dividendYield: stock.summaryDetail?.dividendYield ?? 0,   // Optional: remove if undesired
      earningsGrowth: stock.financialData?.earningsGrowth ?? 0,
      debtRatio: stock.financialData?.debtToEquity ?? 0,
      avg50Days: stock.price?.fiftyDayAverage ?? 0,
      avg200Days: stock.price?.twoHundredDayAverage ?? 0,
    };

    let stockRating = 0;
    // Base scoring.
    if (metrics.volume > computedAvgVolume * 1.1) {
      stockRating += 2;
    } else if (metrics.volume < computedAvgVolume * 0.9) {
      stockRating -= 2;
    }
    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) {
      stockRating += 2;
    } else if (metrics.peRatio > 20) {
      stockRating -= 1;
    }
    if (metrics.earningsGrowth > 0.05) {
      stockRating += 2;
    }
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) {
      stockRating += 2;
    } else if (metrics.debtRatio > 0.7) {
      stockRating -= 2;
    }
    if (metrics.currentPrice > metrics.avg50Days && metrics.avg50Days > metrics.avg200Days) {
      stockRating += 2;
    } else if (metrics.currentPrice < metrics.avg50Days && metrics.avg50Days < metrics.avg200Days) {
      stockRating -= 2;
    }

    // --- Industry Comparison ---
    let industryMetrics = {};
    try {
      industryMetrics = require("./industryMetrics.json");
    } catch (err) {
      console.error("Error loading industryMetrics.json:", err.message);
    }
    // Try to obtain the industry; if missing, fall back to sector.
    const stockIndustry = stock.assetProfile?.industry || stock.assetProfile?.sector || "Unknown";
    if (stockIndustry !== "Unknown" && industryMetrics[stockIndustry]) {
      const indMetrics = industryMetrics[stockIndustry];
      // Compare P/E Ratio.
      if (metrics.peRatio && indMetrics.peRatio) {
        if (metrics.peRatio < indMetrics.peRatio) {
          stockRating += 2;
        } else {
          stockRating -= 2;
        }
      }
      // Compare Earnings Growth versus Industry Revenue Growth.
      // (Assuming earningsGrowth is a fraction and indMetrics.revenueGrowth is a percentage.)
      if (metrics.earningsGrowth && indMetrics.revenueGrowth) {
        if ((metrics.earningsGrowth * 100) > indMetrics.revenueGrowth) {
          stockRating += 2;
        } else {
          stockRating -= 2;
        }
      }
      // Compare Debt-to-Equity.
      if (metrics.debtRatio && indMetrics.debtToEquity) {
        if (metrics.debtRatio < indMetrics.debtToEquity) {
          stockRating += 2;
        } else {
          stockRating -= 2;
        }
      }
      // Compare Dividend Yield if available.
      if (metrics.dividendYield !== undefined && indMetrics.dividendYield !== undefined) {
        if ((metrics.dividendYield * 100) > indMetrics.dividendYield) {
          stockRating += 2;
        } else {
          stockRating -= 2;
        }
      }
    }

    // --- Forecasting ---
    // If industry revenue growth is available, use it as a baseline for industry growth.
    let industryGrowthFraction = 0;
    if (stockIndustry !== "Unknown" && industryMetrics[stockIndustry] && industryMetrics[stockIndustry].revenueGrowth) {
      industryGrowthFraction = industryMetrics[stockIndustry].revenueGrowth / 100; // convert percentage to fraction
    }
    // Use a simple forecasting model:
    // Forecasted future price = currentPrice * (1 + (earningsGrowth + industryGrowthFraction)/2 + bonus)
    // where bonus is +0.02 if the 50-day average is above the 200-day average (bullish), or -0.02 otherwise.
    const bonus = (metrics.avg50Days > metrics.avg200Days) ? 0.02 : -0.02;
    const baseGrowth = (metrics.earningsGrowth + industryGrowthFraction) / 2;
    const forecastPrice = metrics.currentPrice * (1 + baseGrowth + bonus);
    const projectedGrowthPercent = ((forecastPrice - metrics.currentPrice) / metrics.currentPrice) * 100;

    // Determine classification and advice.
    const classification = stockRating > 7 ? "growth" : stockRating >= 0 ? "stable" : "unstable";
    let advice;
    if (intent === "buy") {
      if (stockRating >= 8) advice = "Very Good Stock to Buy";
      else if (stockRating >= 5) advice = "Good Stock to Buy";
      else if (stockRating >= 0) advice = "Okay Stock to Buy";
      else if (stockRating >= -5) advice = "Bad Stock";
      else advice = "Bad Stock to Buy";
    } else if (intent === "sell") {
      advice = stockRating < 0 ? "Sell the Stock" : "Hold the Stock";
    }
    return res.json({
      symbol,
      industry: stockIndustry,
      stockRating,
      classification,
      advice,
      metrics,
      forecast: {
        forecastPrice: forecastPrice.toFixed(2),
        projectedGrowthPercent: projectedGrowthPercent.toFixed(2) + "%"
      }
    });
  } catch (error) {
    console.error("❌ Error fetching stock data:", error);
    return res.status(500).json({ message: "Error fetching stock data.", error: error.message });
  }
});

/******************************************************
 * SECTION C: Stock-Finder Extra Endpoints
 ******************************************************/
// 1) Declare the router
const finderRouter = express.Router();

// 2) Finder route: POST /finder/api/find-stocks
finderRouter.post("/api/find-stocks", async (req, res) => {
  console.log("⏰ Incoming body for find-stocks:", req.body);
  const { stockType, exchange, maxPrice } = req.body;
  if (!stockType || !exchange || maxPrice == null) {
    console.log("❌ Validation failed. Body was:", req.body);
    return res.status(400).json({ message: "stockType, exchange, and maxPrice are required." });
  }
  if (stockType !== "growth" && stockType !== "stable") {
    console.log("❌ Unknown stockType:", stockType);
    return res.status(400).json({ message: "stockType must be either 'growth' or 'stable'." });
  }
  const symbolGroups = require(path.join(__dirname, "symbols.json"));
  console.log("Loaded symbolGroups:", symbolGroups);
  const symbolsForExchange = symbolGroups[exchange.toUpperCase()];
  if (!symbolsForExchange || symbolsForExchange.length === 0) {
    return res.status(404).json({ message: `No symbols found for the exchange: ${exchange}` });
  }
  let filteredSymbols = symbolsForExchange.map((symbolStr) => ({
    symbol: symbolStr,
    exchange,
  }));
  let detailedStocks = await Promise.all(
    filteredSymbols.map(async (symObj) => {
      try {
        await delay(200);
        const detailed = await yahooFinance.quoteSummary(symObj.symbol, {
          modules: ["financialData", "price", "summaryDetail", "defaultKeyStatistics"],
          validate: false,
        });
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
    console.log(`Comparing ${stock.symbol}: Current Price = ${currentPrice}, maxPrice = ${maxPrice}`);
    return currentPrice !== undefined;
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
      // Removed: pbRatio and dividendYield
      earningsGrowth: financialData.earningsGrowth ?? 0,
      debtRatio: financialData.debtToEquity ?? 0,
      avg50Days: priceData.fiftyDayAverage ?? 0,
      avg200Days: priceData.twoHundredDayAverage ?? 0,
    };
    let stockRating = 0;
    if (metrics.volume > avgVolume * 1.1) stockRating += 2;
    else if (metrics.volume < avgVolume * 0.9) stockRating -= 2;
    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) stockRating += 2;
    else if (metrics.peRatio > 20) stockRating -= 1;
    if (metrics.earningsGrowth > 0.05) stockRating += 2;
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) stockRating += 2;
    else if (metrics.debtRatio > 0.7) stockRating -= 2;
    if (metrics.currentPrice > metrics.avg50Days && metrics.avg50Days > metrics.avg200Days) {
      stockRating += 2;
    } else if (metrics.currentPrice < metrics.avg50Days && metrics.avg50Days < metrics.avg200Days) {
      stockRating -= 2;
    }
    const classification = stockRating > 7 ? "growth" : stockRating >= 0 ? "stable" : "unstable";
    let advice;
    if (stockRating >= 8) advice = "Very Good Stock to Buy";
    else if (stockRating >= 5) advice = "Good Stock to Buy";
    else if (stockRating >= 0) advice = "Okay Stock to Buy";
    else if (stockRating >= -5) advice = "Bad Stock";
    else advice = "Bad Stock to Buy";
    return {
      symbol: stock.symbol,
      exchange: stock.exchange,
      currentPrice: metrics.currentPrice,
      metrics,
      stockRating,
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

// 3) Finder Signup Endpoint
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

// 4) Finder Login Endpoint
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

// 5) Attach the Finder Router to the main app
app.use("/finder", finderRouter);

/******************************************************
 * SECTION D: Dashboard Popular Stocks Endpoint with Caching
 * This endpoint returns the top 10 stocks based on daily performance.
 * It accepts a query parameter "marketState" (either "open" or "closed")
 * to determine whether to filter for intraday positive change (open)
 * or simply return the top gainers (when closed).
 * 
 * An in-memory cache is implemented here to avoid making too many API requests.
 ******************************************************/
let popularStocksCache = null;
let popularStocksCacheTimestamp = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

app.get("/api/popular-stocks", async (req, res) => {
  const marketState = req.query.marketState || "open"; // default to "open"
  
  // Check if cached data exists and is fresh
  if (
    popularStocksCache &&
    (Date.now() - popularStocksCacheTimestamp) < CACHE_DURATION &&
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
          const data = await yahooFinance.quoteSummary(symbol, { modules: ["price"], validate: false });
          return { symbol, price: data.price };
        } catch (error) {
          console.error(`Error fetching data for ${symbol}:`, error.message);
          return null;
        }
      })
    );
    stockData = stockData.filter(
      (s) => s !== null && s.price && s.price.regularMarketChangePercent !== undefined
    );
    stockData.sort(
      (a, b) =>
        b.price.regularMarketChangePercent - a.price.regularMarketChangePercent
    );
    if (marketState === "open") {
      stockData = stockData.filter((s) => s.price.regularMarketChangePercent > 0);
    }
    const topStocks = stockData.slice(0, 10).map((s) => ({
      symbol: s.symbol,
      score: s.price.regularMarketChangePercent, // using change percent as a "score"
      metrics: {
        currentPrice: s.price.regularMarketPrice,
        changePercent: s.price.regularMarketChangePercent,
        previousClose: s.price.regularMarketPreviousClose,
      },
    }));
    popularStocksCache = topStocks;
    popularStocksCacheTimestamp = Date.now();
    return res.json(topStocks);
  } catch (error) {
    console.error("❌ Error in /api/popular-stocks:", error.message);
    return res.status(500).json({ message: "Error fetching popular stocks." });
  }
});

/******************************************************
 * START THE COMBINED SERVER
 ******************************************************/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

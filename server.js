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
 * SECTION B: Stock Checker (from stock-checker-server.js)
 ******************************************************/
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent, avgVolume } = req.body;
  if (!symbol || !intent || typeof avgVolume !== "number") {
    return res
      .status(400)
      .json({ message: "Stock symbol, intent (buy/sell), and avgVolume (number) are required." });
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

    if (metrics.currentPrice > metrics.avg50Days && metrics.avg50Days > metrics.avg200Days) {
      stockRating += 2;
    } else if (metrics.currentPrice < metrics.avg50Days && metrics.avg50Days < metrics.avg200Days) {
      stockRating -= 2;
    }

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

    return res.json({ symbol, stockRating, advice, metrics });
  } catch (error) {
    console.error("❌ Error fetching stock data:", error);
    return res.status(500).json({ message: "Error fetching stock data.", error: error.message });
  }
});

/******************************************************
 * SECTION C: Stock-Finder Extra Endpoints
 * These endpoints use unique routes under the "/finder" prefix.
 ******************************************************/
// 1) Declare the router
const finderRouter = express.Router();

// 2) Finder route: POST /finder/api/find-stocks
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
    return res.status(400).json({ message: "stockType must be either 'growth' or 'stable'." });
  }

  // 1. Load the entire JSON object: { NASDAQ: [...], NYSE: [...], TSX: [...] }
  const symbolGroups = require(path.join(__dirname, "symbols.json"));
  console.log("Loaded symbolGroups:", symbolGroups);

  // 2. Access array of strings for user's chosen exchange
  const symbolsForExchange = symbolGroups[exchange.toUpperCase()];
  if (!symbolsForExchange || symbolsForExchange.length === 0) {
    return res
      .status(404)
      .json({ message: `No symbols found for the exchange: ${exchange}` });
  }

  // 3. Convert each string symbol into { symbol, exchange }
  let filteredSymbols = symbolsForExchange.map((symbolStr) => ({
    symbol: symbolStr,
    exchange,
  }));

  // 4. Fetch Yahoo Finance data for each symbol
  let detailedStocks = await Promise.all(
    filteredSymbols.map(async (symObj) => {
      try {
        const detailed = await yahooFinance.quoteSummary(symObj.symbol, {
          modules: [
            "financialData",
            "price",
            "summaryDetail",
            "defaultKeyStatistics",
          ],
        });
        return { ...symObj, detailed };
      } catch (error) {
        console.error(`Error fetching data for ${symObj.symbol}:`, error.message);
        return null;
      }
    })
  );

  // Filter out nulls (failed lookups)
  detailedStocks = detailedStocks.filter((stock) => stock !== null);

  // Debug: Log current prices
  console.log("🔎 Checking current prices for symbols in exchange:", exchange);
  detailedStocks.forEach((stock) => {
    const currentPrice = stock.detailed?.price?.regularMarketPrice;
    console.log(`Symbol: ${stock.symbol} - Current Price: ${currentPrice}`);
  });

  // 5. Filter by maxPrice or relax the filter for debugging
  let priceFilteredStocks = detailedStocks.filter((stock) => {
    const currentPrice = stock.detailed?.price?.regularMarketPrice;
    console.log(
      `Comparing ${stock.symbol}: Current Price = ${currentPrice}, maxPrice = ${maxPrice}`
    );
    // Return all with a defined currentPrice for debugging:
    return currentPrice !== undefined;
    // For strict filter: 
    // return currentPrice !== undefined && currentPrice <= maxPrice;
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

  // 6. Calculate average volume
  const totalVolume = priceFilteredStocks.reduce((sum, stock) => {
    const vol = stock.detailed?.price?.regularMarketVolume ?? 0;
    return sum + vol;
  }, 0);
  const avgVolume = totalVolume / priceFilteredStocks.length;
  console.log(`Calculated average volume: ${avgVolume}`);

  // 7. Score & classify
  const evaluatedStocks = priceFilteredStocks.map((stock) => {
    const priceData = stock.detailed.price || {};
    const summaryData = stock.detailed.summaryDetail || {};
    const financialData = stock.detailed.financialData || {};

    const metrics = {
      volume: priceData.regularMarketVolume ?? 0,
      currentPrice: priceData.regularMarketPrice ?? 0,
      peRatio: summaryData.trailingPE ?? 0,
      pbRatio: summaryData.priceToBook ?? 0,
      dividendYield: summaryData.dividendYield ?? 0,
      earningsGrowth: financialData.earningsGrowth ?? 0,
      debtRatio: financialData.debtToEquity ?? 0,
      avg50Days: priceData.fiftyDayAverage ?? 0,
      avg200Days: priceData.twoHundredDayAverage ?? 0,
    };

    let stockRating = 0;

    // Scoring based on volume relative to avgVolume
    if (metrics.volume > avgVolume * 1.1) stockRating += 2;
    else if (metrics.volume < avgVolume * 0.9) stockRating -= 2;

    // P/E ratio
    if (metrics.peRatio >= 10 && metrics.peRatio <= 20) stockRating += 2;
    else if (metrics.peRatio > 20) stockRating -= 1;

    // P/B ratio
    if (metrics.pbRatio < 1) stockRating += 2;
    else if (metrics.pbRatio > 3) stockRating -= 2;

    // Dividend yield + earnings growth
    if (metrics.dividendYield > 0.05) stockRating += 2;
    if (metrics.earningsGrowth > 0.05) stockRating += 2;

    // Debt-to-equity
    if (metrics.debtRatio >= 0 && metrics.debtRatio <= 0.5) stockRating += 2;
    else if (metrics.debtRatio > 0.7) stockRating -= 2;

    // Moving averages
    if (metrics.currentPrice > metrics.avg50Days && metrics.avg50Days > metrics.avg200Days) {
      stockRating += 2;
    } else if (
      metrics.currentPrice < metrics.avg50Days &&
      metrics.avg50Days < metrics.avg200Days
    ) {
      stockRating -= 2;
    }

    // Classification
    const classification =
      stockRating > 7 ? "growth" : stockRating >= 0 ? "stable" : "unstable";

    // Advice
    let advice;
    if (stockRating >= 25) advice = "Very Good Stock to Buy";
    else if (stockRating >= 15) advice = "Good Stock to Buy";
    else if (stockRating >= 5) advice = "Okay Stock to Buy";
    else if (stockRating >= -5) advice = "Neutral Stock";
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

  // Log all evaluated stocks
  console.log("Evaluated Stocks:", evaluatedStocks);

  // 8. Filter by user's desired stockType
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
 * START THE COMBINED SERVER
 ******************************************************/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Combined server running on port ${PORT}`);
});

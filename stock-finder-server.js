const express = require("express");
const cors = require("cors");
const fs = require("fs");
const yahooFinance = require("yahoo-finance2").default;
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 5002; // ✅ Now running on port 5002

// Load symbols and industry data
let symbols = {};
let industryMetrics = {};
try {
    symbols = JSON.parse(fs.readFileSync("symbols.json", "utf-8"));
    industryMetrics = JSON.parse(fs.readFileSync("industryMetrics.json", "utf-8"));
    console.log(`✅ Loaded symbols and industry data.`);
} catch (error) {
    console.error("❌ Error reading symbols or industry data:", error.message);
}

// Cache stock data for 10 minutes
const stockCache = {};
const CACHE_DURATION = 10 * 60 * 1000;

/**
 * Fetch stock data for multiple symbols in batches
 */
async function fetchStockDataBatch(stockSymbols) {
    console.log(`🔄 Fetching batch of ${stockSymbols.length} stocks...`);

    const stockData = await Promise.allSettled(
        stockSymbols.map(async (symbol) => {
            try {
                if (stockCache[symbol] && Date.now() - stockCache[symbol].timestamp < CACHE_DURATION) {
                    console.log(`⚡ Using cached data for ${symbol}`);
                    return { symbol, ...stockCache[symbol].data };
                }

                const quote = await yahooFinance.quoteSummary(symbol, { modules: ["financialData", "summaryProfile", "summaryDetail"] });

                if (!quote || !quote.financialData || !quote.summaryProfile || !quote.summaryDetail) throw new Error("Invalid API response");

                const industry = quote.summaryProfile?.industry || "Unknown";

                const metrics = {
                    revenueGrowth: quote.financialData?.revenueGrowth ?? 0,
                    epsGrowth: quote.financialData?.epsGrowth ?? 0,
                    peRatio: quote.financialData?.forwardPE ?? 100,
                    dividendYield: quote.financialData?.dividendYield ?? 0,
                    debtToEquity: quote.financialData?.debtToEquity ?? 5,
                    pbRatio: quote.financialData?.priceToBook ?? 5,
                    freeCashFlow: quote.financialData?.freeCashFlowPerShare ?? 0,
                    operatingMargin: quote.financialData?.operatingMargins ?? 0,
                    shortInterest: quote.financialData?.shortPercentOfFloat ?? 0.1,
                    beta: quote.financialData?.beta ?? 1,
                    price: quote.financialData?.currentPrice ?? quote.summaryDetail?.previousClose ?? "N/A", // ✅ Fallback for missing price
                };

                const stockInfo = {
                    symbol,
                    industry,
                    score: calculateScore(metrics, industry),
                    metrics,
                };

                stockCache[symbol] = { data: stockInfo, timestamp: Date.now() };
                return stockInfo;

            } catch (error) {
                console.error(`❌ Error fetching ${symbol}:`, error.message);
                return null;
            }
        })
    );

    return stockData.filter(result => result.status === "fulfilled" && result.value !== null).map(result => result.value);
}


/**
 * Calculate stock score based on metrics and industry norms
 */
function calculateScore(metrics, industry) {
    let score = 10; // Baseline score

    const industryAvg = industryMetrics[industry] || {
        peRatio: 20,
        revenueGrowth: 0.1,
        dividendYield: 0.02,
        debtToEquity: 1.5,
    };

    const normalize = (value, mean, stdDev) => {
        const z = (value - mean) / (stdDev || 1);
        return Math.max(-3, Math.min(3, z));
    };

    const peScore = normalize(metrics.peRatio, industryAvg.peRatio, 10);
    const revenueGrowthScore = normalize(metrics.revenueGrowth, industryAvg.revenueGrowth, 0.1);
    const dividendYieldScore = normalize(metrics.dividendYield, industryAvg.dividendYield, 0.01);
    const debtToEquityScore = normalize(metrics.debtToEquity, industryAvg.debtToEquity, 1);

    score += -peScore * 1.5;
    score += revenueGrowthScore * 4;
    score += dividendYieldScore * 2;
    score += -debtToEquityScore * 1.5;

    return Math.round(score * 10) / 10;
}

/**
 * Fetch all stocks for an exchange
 */
async function getAllStocksForExchange(exchange) {
    if (!symbols[exchange]) return [];
    return await fetchStockDataBatch(symbols[exchange].slice(0, 100)); // Limit to 100 for speed
}


// API route to find stocks
app.post("/api/find-stocks", async (req, res) => {
    const { stockType, exchange, maxAmount } = req.body;

    console.log(`📌 Received stock request: Type=${stockType}, Exchange=${exchange}, MaxPrice=${maxAmount}`);

    if (!stockType || !exchange || isNaN(maxAmount)) {
        return res.status(400).json({ error: "❌ Invalid request parameters." });
    }

    if (!symbols[exchange]) {
        return res.status(400).json({ error: "❌ Exchange not found." });
    }

    const stockSymbols = symbols[exchange].slice(0, 100); // Limit to first 100 stocks
    const stockData = await fetchStockDataBatch(stockSymbols);

    // **Filter based on stockType (Growth vs. Stable)**
    let filteredStocks = stockData.filter(stock => stock.metrics);

    if (stockType === "growth") {
        filteredStocks = filteredStocks.sort((a, b) => b.metrics.revenueGrowth - a.metrics.revenueGrowth);
    } else if (stockType === "stable") {
        filteredStocks = filteredStocks.sort((a, b) => a.metrics.debtToEquity - b.metrics.debtToEquity);
    }

    // **Filter by price range**
    filteredStocks = filteredStocks.filter(stock => stock.metrics.price <= maxAmount);
    
    console.log("✅ Final Selected Stocks:", JSON.stringify(filteredStocks, null, 2)); 
    res.json(filteredStocks.slice(0, 5));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Stock Finder API running at http://localhost:${PORT}`);
});


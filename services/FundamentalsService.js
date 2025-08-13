// backend/services/FundamentalsService.js

require("dotenv").config();
const path  = require("path");
const axios = require("axios");

// 1) Load the industryMetrics.json that lives in /backend
const industryMetrics = require(
  path.join(__dirname, "..", "industryMetrics.json")
);

// 2) Load your local helpers from the same folder
const { fetchWithFallback } = require("./fundamentalsProvider");
const { loadFmpAll }        = require("./fmpRawService");

const FMP_API_KEY = process.env.FMP_API_KEY;
if (!FMP_API_KEY) {
  console.warn(
    "⚠️  No FMP_API_KEY in .env—profile & reports may be missing"
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseNumber(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function computeRating(r) {
  let score = 0;
  if (r.netMargin    != null) score += r.netMargin    * 10;
  if (r.roa          != null) score += r.roa          * 10;
  if (r.roe          != null) score += r.roe          * 10;
  if (r.debtToEquity != null)
    score -= Math.min(r.debtToEquity, 3) * 5;
  if (r.currentRatio != null)
    score += Math.min(r.currentRatio, 2) * 2;
  return +score.toFixed(2);
}

function evaluateWeaknesses(r, bm) {
  const flags = [];
  if (r.netMargin != null && r.netMargin < 0)
    flags.push({ flag: "Negative net margin", value: r.netMargin });
  if (r.operatingMargin != null && r.operatingMargin < 0)
    flags.push({ flag: "Negative operating margin", value: r.operatingMargin });
  if (r.roa != null && r.roa < 0)
    flags.push({ flag: "Negative ROA", value: r.roa });
  if (
    r.grossMargin != null &&
    bm.grossMargin != null &&
    r.grossMargin < bm.grossMargin * 0.9
  )
    flags.push({
      flag: "Low gross margin",
      value: r.grossMargin,
      benchmark: bm.grossMargin,
    });
  if (
    r.peRatio != null &&
    bm.peRatio != null &&
    r.peRatio > bm.peRatio * 1.2
  )
    flags.push({
      flag: "High valuation (PE)",
      value: r.peRatio,
      benchmark: bm.peRatio,
    });
  if (
    r.debtToEquity != null &&
    bm.debtToEquity != null &&
    r.debtToEquity > bm.debtToEquity * 1.1
  )
    flags.push({
      flag: "High leverage",
      value: r.debtToEquity,
      benchmark: bm.debtToEquity,
    });
  if (
    r.currentRatio != null &&
    bm.currentRatio != null &&
    r.currentRatio < bm.currentRatio * 0.9
  )
    flags.push({
      flag: "Low liquidity",
      value: r.currentRatio,
      benchmark: bm.currentRatio,
    });
  if (r.interestCoverage != null && r.interestCoverage < 1)
    flags.push({
      flag: "Insufficient interest coverage",
      value: r.interestCoverage,
    });
  if (
    r.priceToSales != null &&
    bm.priceToSales != null &&
    r.priceToSales < bm.priceToSales * 0.5
  )
    flags.push({
      flag: "Very low price-to-sales",
      value: r.priceToSales,
      benchmark: bm.priceToSales,
    });
  return flags;
}

// ── Main function ──────────────────────────────────────────────────────────
async function getFundamentals(symbol) {
  // strip any “.TO” or similar suffix
  const lookupSymbol = symbol.includes(".")
    ? symbol.split(".")[0]
    : symbol;

  // 1) live profile + fallback
  let profile, rawRatios, inc, bs;
  try {
    const pf = await axios.get(
      `https://financialmodelingprep.com/api/v3/profile/${lookupSymbol}`,
      { params: { apikey: FMP_API_KEY } }
    );
    profile = pf.data?.[0] || {};
    ({ profile, rawRatios, inc, bs } = await loadFmpAll(lookupSymbol));
  } catch (e) {
    console.warn(
      `⚠️  Live profile fetch failed for ${symbol} ` +
        `(status ${e.response?.status || e.message}), using cache`
    );
    ({ profile, rawRatios, inc, bs } = await loadFmpAll(lookupSymbol));
  }
  const currentPrice = parseNumber(profile.price);

  // 2) Company info
  const companyInfo = {
    name:        profile.companyName,
    website:     profile.website,
    description: profile.description,
    reports: {
      incomeStatement: `https://financialmodelingprep.com/api/v3/income-statement/${lookupSymbol}?apikey=${FMP_API_KEY}`,
      balanceSheet:    `https://financialmodelingprep.com/api/v3/balance-sheet-statement/${lookupSymbol}?apikey=${FMP_API_KEY}`,
      cashFlow:        `https://financialmodelingprep.com/api/v3/cash-flow-statement/${lookupSymbol}?apikey=${FMP_API_KEY}`,
    },
  };

  // 3) Ratios via fallback
  const keys = [
    "grossMargin", "operatingMargin", "netMargin",
    "roa", "roe", "currentRatio", "quickRatio",
    "debtToEquity", "interestCoverage",
    "assetTurnover", "inventoryTurnover", "receivablesTurnover",
    "peRatio", "priceToBook", "priceToSales", "dividendYield",
  ];
  const rawResults = await Promise.all(
    keys.map(k => fetchWithFallback(lookupSymbol, k))
  );
  const ratios = keys.reduce((acc, k, i) => {
    acc[k] = parseNumber(rawResults[i]);
    return acc;
  }, {});

  // 4) Benchmarks & scoring
  const industry = profile.sector || "Unknown";
  const defaultBenchmarks = {
    peRatio: null,
    revenueGrowth: null,
    dividendYield: null,
    debtToEquity: null,
  };
  const benchmarks = {
    ...defaultBenchmarks,
    ...(industryMetrics[industry] || {}),
  };
  const rating     = computeRating(ratios);
  const weaknesses = evaluateWeaknesses(ratios, benchmarks);

  // 5) News + sentiment
  let news = [];
  try {
    const RSSParser = require("rss-parser");
    const Sentiment = require("sentiment");
    const parser    = new RSSParser();
    const sentiment = new Sentiment();

    const feed = await parser.parseURL(
      `https://news.google.com/rss/search?q=${symbol}`
    );
    news = await Promise.all(
      feed.items.slice(0,5).map(async item => {
        let snippet = item.contentSnippet || item.title;
        try {
          const html = await axios.get(item.link).then(r => r.data);
          const $    = require("cheerio").load(html);
          snippet    = $("p").first().text() || snippet;
        } catch {}
        return {
          title:     item.title,
          link:      item.link,
          snippet:   snippet.slice(0,200) + (snippet.length>200?"…":""), 
          sentiment: sentiment.analyze(snippet).score
        };
      })
    );
  } catch (_) {
    // ignore news errors
  }

  // 6) Valuation & advice
  let valuation = null;
  let advice    = "No valuation signal available.";
  if (
    ratios.peRatio > 0 &&
    benchmarks.peRatio > 0 &&
    currentPrice != null
  ) {
    const fairPrice = +(
      (benchmarks.peRatio / ratios.peRatio) *
      currentPrice
    ).toFixed(2);
    const status = fairPrice > currentPrice ? "undervalued" : "overvalued";
    valuation = { fairPrice, status };
    advice    =
      status === "undervalued"
        ? "Price below peer PE average—consider a closer look."
        : "Price above peer PE average—be cautious of overpaying.";
  }

  return {
    symbol,
    companyInfo,
    ratios,
    benchmarks,
    rating,
    weaknesses,
    valuation,
    advice,
    news,
    currentPrice,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getFundamentals };

// services/FundamentalsService.js

require("dotenv").config();
const axios               = require("axios");
const industryMetrics     = require("../industryMetrics.json");
const { fetchWithFallback } = require("./fundamentalsProvider");
const { loadFmpAll }      = require("./fmpRawService");

const FMP_API_KEY = process.env.FMP_API_KEY;
if (!FMP_API_KEY) {
  console.warn("⚠️  No FMP_API_KEY in .env—profile & reports may be missing");
}

// Helpers
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
  if (r.debtToEquity != null) score -= Math.min(r.debtToEquity, 3) * 5;
  if (r.currentRatio != null) score += Math.min(r.currentRatio, 2) * 2;
  return +score.toFixed(2);
}

function evaluateWeaknesses(r, bm) {
  const flags = [];
  if (r.netMargin    != null && r.netMargin    < 0) flags.push({ flag: "Negative net margin",            value: r.netMargin    });
  if (r.operatingMargin != null && r.operatingMargin < 0) flags.push({ flag: "Negative operating margin",     value: r.operatingMargin });
  if (r.roa          != null && r.roa          < 0) flags.push({ flag: "Negative ROA",                   value: r.roa          });
  if (r.grossMargin  != null && bm.grossMargin  != null && r.grossMargin  < bm.grossMargin  * 0.9)
    flags.push({ flag: "Low gross margin",  value: r.grossMargin,  benchmark: bm.grossMargin  });
  if (r.peRatio      != null && bm.peRatio      != null && r.peRatio      > bm.peRatio      * 1.2)
    flags.push({ flag: "High valuation (PE)", value: r.peRatio,      benchmark: bm.peRatio      });
  if (r.debtToEquity != null && bm.debtToEquity != null && r.debtToEquity > bm.debtToEquity * 1.1)
    flags.push({ flag: "High leverage",     value: r.debtToEquity, benchmark: bm.debtToEquity });
  if (r.currentRatio != null && bm.currentRatio != null && r.currentRatio < bm.currentRatio * 0.9)
    flags.push({ flag: "Low liquidity",     value: r.currentRatio, benchmark: bm.currentRatio });
  if (r.interestCoverage != null && r.interestCoverage < 1)
    flags.push({ flag: "Insufficient interest coverage", value: r.interestCoverage });
  if (r.priceToSales != null && bm.priceToSales != null && r.priceToSales < bm.priceToSales * 0.5)
    flags.push({ flag: "Very low price-to-sales", value: r.priceToSales, benchmark: bm.priceToSales });
  return flags;
}

async function getFundamentals(symbol) {
  // --- step 1: live profile or fall back to stale cache ---
  let profile, rawRatios, inc, bs;
  try {
    // try live profile call
    const pf = await axios.get(
      `https://financialmodelingprep.com/api/v3/profile/${symbol}`,
      { params: { apikey: FMP_API_KEY } }
    );
    profile = pf.data?.[0] || {};
    // now fetch the rest via your cached loader
    ({ profile, rawRatios, inc, bs } = await loadFmpAll(symbol));
  } catch (e) {
    console.warn(
      `⚠️  Unable to fetch live profile for "${symbol}" ` +
      `(status ${e.response?.status || e.message}), using cached data`
    );
    ({ profile, rawRatios, inc, bs } = await loadFmpAll(symbol));
  }
  const currentPrice = parseNumber(profile.price);

  // --- step 2: company info & report URLs ---
  const companyInfo = {
    name:        profile.companyName,
    website:     profile.website,
    description: profile.description,
    reports: {
      incomeStatement: `https://financialmodelingprep.com/api/v3/income-statement/${symbol}?apikey=${FMP_API_KEY}`,
      balanceSheet:    `https://financialmodelingprep.com/api/v3/balance-sheet-statement/${symbol}?apikey=${FMP_API_KEY}`,
      cashFlow:        `https://financialmodelingprep.com/api/v3/cash-flow-statement/${symbol}?apikey=${FMP_API_KEY}`,
    }
  };

  // --- step 3: ratios via fallback chain ---
  const keys = [
    "grossMargin","operatingMargin","netMargin",
    "roa","roe","currentRatio","quickRatio",
    "debtToEquity","interestCoverage",
    "assetTurnover","inventoryTurnover","receivablesTurnover",
    "peRatio","priceToBook","priceToSales","dividendYield"
  ];
  const rawResults = await Promise.all(keys.map(k => fetchWithFallback(symbol, k)));
  const ratios = keys.reduce((acc, k, i) => {
    acc[k] = parseNumber(rawResults[i]);
    return acc;
  }, {});

  // --- step 4: benchmarks & scoring ---
  const industry   = profile.sector || "Unknown";
  const benchmarks = industryMetrics[industry] || {};
  const rating     = computeRating(ratios);
  const weaknesses = evaluateWeaknesses(ratios, benchmarks);

  // --- step 5: fetch news + sentiment ---
  let news = [];
  try {
    const RSSParser = require("rss-parser");
    const Sentiment = require("sentiment");
    const parser    = new RSSParser();
    const sentiment = new Sentiment();

    const feed = await parser.parseURL(`https://news.google.com/rss/search?q=${symbol}`);
    news = await Promise.all(feed.items.slice(0,5).map(async item => {
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
    }));
  } catch (_) {
    // swallow news errors
  }

  // --- step 6: fair-value & advice ---
  let valuation = null, advice = "No valuation signal available.";
  if (ratios.peRatio > 0 && benchmarks.peRatio > 0 && currentPrice != null) {
    const fairPrice = +((benchmarks.peRatio/ratios.peRatio) * currentPrice).toFixed(2);
    const status    = fairPrice > currentPrice ? "undervalued" : "overvalued";
    valuation = { fairPrice, status };
    advice    = status === "undervalued"
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
    fetchedAt: new Date().toISOString()
  };
}

module.exports = { getFundamentals };

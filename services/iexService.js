// services/iexService.js
require("dotenv").config();
const axios = require("axios");

const IEX_API_KEY = process.env.IEX_API_KEY;
if (!IEX_API_KEY) {
  console.warn("⚠️  No IEX_API_KEY in .env—some fallbacks may be missing");
}

const BASE = "https://cloud.iexapis.com/stable";

async function fetchStats(symbol) {
  try {
    const res = await axios.get(
      `${BASE}/stock/${symbol}/stats`,
      { params: { token: IEX_API_KEY } }
    );
    return res.data || {};
  } catch (err) {
    console.error("IEX stats error:", err.message);
    return {};
  }
}

async function getMetric(symbol, metricKey) {
  const stats = await fetchStats(symbol);
  switch (metricKey) {
    case "peRatio":       return stats.peRatio ?? null;
    case "priceToBook":   return stats.priceToBook ?? null;
    case "dividendYield": return stats.dividendYield ?? null;
    case "debtToEquity":  return stats.debtToEquity ?? null;
    case "grossMargin":   return stats.grossMargin ?? null;
    case "roa":           return stats.returnOnAssets ?? null;
    case "roe":           return stats.returnOnEquity ?? null;
    default:              return null;
  }
}

module.exports = { getMetric };

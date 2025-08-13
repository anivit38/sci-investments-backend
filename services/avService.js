// services/avService.js
require("dotenv").config();
const axios = require("axios");
const API_KEY = process.env.AV_API_KEY;
const BASE    = "https://www.alphavantage.co/query";

async function getMetric(symbol, metricKey) {
  try {
    const res = await axios.get(BASE, {
      params: {
        function: "OVERVIEW",
        symbol,
        apikey: API_KEY
      }
    });
    const data = res.data || {};
    switch(metricKey) {
      case "grossMargin":      return parseFloat(data.GrossProfitRatio) || null;
      case "operatingMargin":  return parseFloat(data.OperatingMarginTTM) || null;
      case "netMargin":        return parseFloat(data.NetProfitMarginTTM) || null;
      case "roa":              return parseFloat(data.ReturnOnAssetsTTM) || null;
      case "roe":              return parseFloat(data.ReturnOnEquityTTM) || null;
      case "peRatio":          return parseFloat(data.PERatio) || null;
      case "priceToBook":      return parseFloat(data.PriceToBookRatio) || null;
      case "dividendYield":    return parseFloat(data.DividendYield) || null;
      default:                 return null;
    }
  } catch (err) {
    console.error("AlphaVantage error:", err.message);
    return null;
  }
}

module.exports = { getMetric };

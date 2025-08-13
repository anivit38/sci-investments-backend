// services/yahooMetrics.js
const yahooFinance = require("yahoo-finance2").default;

async function getMetric(symbol, metricKey) {
  try {
    const data = await yahooFinance.quoteSummary(symbol, {
      modules: ["summaryDetail", "defaultKeyStatistics"]
    });
    const sd = data.summaryDetail || {};
    const ks = data.defaultKeyStatistics || {};

    switch (metricKey) {
      case "peRatio":       return sd.trailingPE      ?? null;
      case "priceToBook":   return sd.priceToBook     ?? null;
      case "dividendYield": return sd.dividendYield   ?? null;
      default:              return null;
    }
  } catch {
    return null;
  }
}

module.exports = { getMetric };

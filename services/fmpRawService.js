// backend/services/fmpRawService.js

require("dotenv").config();
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const FMP_API_KEY = process.env.FMP_API_KEY;
if (!FMP_API_KEY) {
  console.warn("⚠️  No FMP_API_KEY in .env—FMP calls will fail");
}

// Disk cache setup
const CACHE_PATH = path.resolve(__dirname, "../cache/fmp.json");
const CACHE_TTL  = 24 * 60 * 60 * 1000;  // 24h

let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8") || "{}");
} catch {
  cache = {};
}

function saveCache() {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * loadFmpAll(symbol)
 * • Returns { profile, rawRatios, inc, bs }
 * • Caches on disk per-symbol; falls back to stale on 429
 * • Never throws—always returns at least empty structs
 */
async function loadFmpAll(symbol) {
  const now   = Date.now();
  const entry = cache[symbol];

  if (entry && now - entry.fetchedAt < CACHE_TTL) {
    return entry.data;
  }

  let profileRes, ratiosRes, incRes, bsRes;
  try {
    [profileRes, ratiosRes, incRes, bsRes] = await Promise.all([
      axios.get(`https://financialmodelingprep.com/api/v3/profile/${symbol}`, {
        params: { apikey: FMP_API_KEY },
      }),
      axios.get(`https://financialmodelingprep.com/api/v3/ratios/${symbol}`, {
        params: { apikey: FMP_API_KEY, limit: 1 },
      }),
      axios.get(`https://financialmodelingprep.com/api/v3/income-statement/${symbol}`, {
        params: { apikey: FMP_API_KEY, limit: 2 },
      }),
      axios.get(`https://financialmodelingprep.com/api/v3/balance-sheet-statement/${symbol}`, {
        params: { apikey: FMP_API_KEY, limit: 2 },
      }),
    ]);
  } catch (err) {
    if (err.response?.status === 429 && entry) {
      console.warn(
        `⚠️  FMP rate limit hit for "${symbol}", using cached data from ` +
        new Date(entry.fetchedAt).toLocaleString()
      );
      return entry.data;
    }
    console.warn(`⚠️  FMP fetch failed for "${symbol}": ${err.message}`);
  }

  const data = {
    profile:   profileRes?.data?.[0] || {},
    rawRatios: ratiosRes?.data?.[0]   || {},
    inc:       incRes?.data            || [],
    bs:        bsRes?.data             || [],
  };

  cache[symbol] = { fetchedAt: now, data };
  saveCache();
  return data;
}

/**
 * getMetric(symbol, metricKey)
 * Tries, in order:
 *  1) rawRatios
 *  2) profile fields
 *  3) computed from inc & bs
 */
async function getMetric(symbol, metricKey) {
  try {
    const { profile, rawRatios, inc, bs } = await loadFmpAll(symbol);

    // 1) rawRatios mapping
    const mapRaw = {
      grossMargin:         rawRatios.grossProfitMargin,
      operatingMargin:     rawRatios.operatingProfitMargin,
      netMargin:           rawRatios.netProfitMargin,
      roa:                 rawRatios.returnOnAssets,
      roe:                 rawRatios.returnOnEquity,
      debtToEquity:        rawRatios.debtToEquity ?? rawRatios.debtEquity,
      assetTurnover:       rawRatios.assetTurnoverRatio,
      inventoryTurnover:   rawRatios.inventoryTurnoverRatio,
      receivablesTurnover: rawRatios.receivablesTurnoverRatio,
      priceToSales:        rawRatios.priceToSalesRatio,
      interestCoverage:    rawRatios.interestCoverage,
    };
    if (mapRaw[metricKey] != null) {
      return parseFloat(mapRaw[metricKey]);
    }

    // 2) profile-based
    if (metricKey === "peRatio" && profile.pe != null) {
      return parseFloat(profile.pe);
    }
    if (metricKey === "priceToBook" && profile.priceToBook != null) {
      return parseFloat(profile.priceToBook);
    }
    if (metricKey === "dividendYield" && profile.lastDiv != null) {
      return parseFloat(profile.lastDiv);
    }

    // 3) compute from inc & bs
    // currentRatio
    if (metricKey === "currentRatio" && bs[0]) {
      const { totalCurrentAssets, totalCurrentLiabilities } = bs[0];
      if (totalCurrentAssets && totalCurrentLiabilities) {
        return totalCurrentAssets / totalCurrentLiabilities;
      }
    }

    // quickRatio
    if (metricKey === "quickRatio" && bs[0]) {
      const { totalCurrentAssets, inventory, totalCurrentLiabilities } = bs[0];
      if (totalCurrentAssets && inventory != null && totalCurrentLiabilities) {
        return (totalCurrentAssets - inventory) / totalCurrentLiabilities;
      }
    }

    // priceToSales
    if (metricKey === "priceToSales" && profile.mktCap && inc[0]) {
      const rev = inc[0].revenue;
      if (rev) {
        return profile.mktCap / rev;
      }
    }

    // interestCoverage
    if (metricKey === "interestCoverage" && inc[0]) {
      const { ebit, interestExpense } = inc[0];
      if (ebit != null && interestExpense) {
        return ebit / Math.abs(interestExpense);
      }
    }

    // debtToEquity fallback
    if (metricKey === "debtToEquity" && bs.length >= 2) {
      const [b1, b2] = bs;
      const eqAvg = (b1.totalStockholdersEquity + b2.totalStockholdersEquity) / 2;
      if (eqAvg) {
        return b1.totalDebt / eqAvg;
      }
    }

    // assetTurnover
    if (metricKey === "assetTurnover" && inc[0] && bs.length >= 2) {
      const [i1] = inc;
      const [b1, b2] = bs;
      const avgA = (b1.totalAssets + b2.totalAssets) / 2;
      if (avgA) {
        return i1.revenue / avgA;
      }
    }

    // inventoryTurnover
    if (metricKey === "inventoryTurnover" && inc[0] && bs.length >= 2) {
      const [i1] = inc;
      const [b1, b2] = bs;
      const avgI = (b1.inventory + b2.inventory) / 2;
      if (avgI) {
        return i1.costOfRevenue / avgI;
      }
    }

    // receivablesTurnover
    if (metricKey === "receivablesTurnover" && inc[0] && bs.length >= 2) {
      const [i1] = inc;
      const [b1, b2] = bs;
      const ar1 = b1.accountsReceivable ?? b1.netReceivables;
      const ar2 = b2.accountsReceivable ?? b2.netReceivables;
      const avgR = (ar1 + ar2) / 2;
      if (avgR) {
        return i1.revenue / avgR;
      }
    }

    // <— NEW: priceToBook fallback from BS
    if (metricKey === "priceToBook" && profile.mktCap && bs[0]) {
      const equity = bs[0].totalStockholdersEquity;
      if (equity) {
        return profile.mktCap / equity;
      }
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = {
  getMetric,
  loadFmpAll,    // <— add this
};

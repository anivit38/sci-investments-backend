/**
 * Compute key ratios from raw Alpha Vantage data.
 * Expand this with any additional ratios you need.
 */
function computeRatios(raw) {
  // Grab the most recent annual reports
  const latestIncome  = raw.income?.annualReports?.[0]  || {};
  const latestBalance = raw.balance?.annualReports?.[0] || {};

  // Parse out the numbers
  const revenue      = parseFloat(latestIncome.totalRevenue)     || 0;
  const netIncome    = parseFloat(latestIncome.netIncome)       || 0;
  const eps          = parseFloat(latestIncome.eps)             || 0;
  const assets       = parseFloat(latestBalance.totalAssets)    || 0;
  const liabilities  = parseFloat(latestBalance.totalLiabilities) || 0;
  const equity       = assets - liabilities;

  return {
    profitMargin: revenue ? netIncome / revenue : null,
    debtEquity:   equity  ? liabilities / equity   : null,
    peRatio:      eps     ? parseFloat(raw.overview?.MarketCapitalization) / eps : null,
    // TODO: add currentRatio, ROE, inventoryTurnover, etc.
  };
}

module.exports = { computeRatios };

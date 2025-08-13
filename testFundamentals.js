// testFundamentals.js
const { parseNumber, evaluateWeaknesses } = require("./services/FundamentalsService");

// 1) Construct a sample ratios object that triggers each flag:
const sampleRatios = {
  grossMargin: 0.20,      // low (benchmark 0.30)
  peRatio: 50,            // high  (benchmark 40)
  debtToEquity: 3.0,      // high  (benchmark 2.5)
  currentRatio: 0.8,      // low   (benchmark 1.0)
  // extras won’t flag:
  operatingMargin: 0.25,
  netMargin: 0.15,
  roa: 0.10,
  roe: 0.20,
  quickRatio: 0.75,
  interestCoverage: 5,
  assetTurnover: 1.2,
  inventoryTurnover: 4,
  receivablesTurnover: 6,
  priceToBook: 5,
  priceToSales: 2,
  dividendYield: 0.02,
};

// 2) Matching benchmarks:
const sampleBenchmarks = {
  grossMargin: 0.30,
  peRatio: 40,
  debtToEquity: 2.5,
  currentRatio: 1.0,
  // benchmarks for other ratios (not used in our checks):
  operatingMargin: 0.30,
  netMargin: 0.20,
  roa: 0.15,
  roe: 0.25,
  quickRatio: 1.0,
  interestCoverage: 10,
  assetTurnover: 1.5,
  inventoryTurnover: 5,
  receivablesTurnover: 7,
  priceToBook: 4,
  priceToSales: 3,
  dividendYield: 0.03,
};

// 3) Run the evaluator:
const flags = evaluateWeaknesses(sampleRatios, sampleBenchmarks);
console.log("Weakness flags detected:\n", flags);

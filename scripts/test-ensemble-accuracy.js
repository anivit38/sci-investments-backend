// backend/scripts/test-ensemble-accuracy.js
const { getEnsemblePrediction } = require('../services/EnsembleService');
const { yf: yahooFinance, historicalCompat } = require('../lib/yfCompat');


/** Map days -> yahoo chart() "range" */
function rangeFromDays(days) {
  if (days <= 5) return '5d';
  if (days <= 30) return '1mo';
  if (days <= 90) return '3mo';
  if (days <= 180) return '6mo';
  if (days <= 365) return '1y';
  if (days <= 730) return '2y';
  return '5y';
}

async function testAccuracy({
  symbols = ['MSFT', 'AAPL', 'NVDA', 'AMD'],
  days = 30,
  holdTolerancePct = 0.003, // 0.3% = treat tiny moves as "flat" for HOLD
} = {}) {
  let correct = 0, total = 0;

  const range = rangeFromDays(days);
  console.log(`Range used for price truth: ${range} (${days}d requested)\n`);

  for (const sym of symbols) {
    try {
      process.stdout.write(`Testing ${sym}... `);

      // 1) Get ensemble prediction (your meta-decider)
      const pred = await getEnsemblePrediction(sym);

      // 2) Fetch recent price truth from Yahoo
      const { quotes } = await yahooFinance.chart(sym, { range, interval: '1d' });
      if (!quotes || quotes.length < 2) {
        console.log('insufficient price data');
        continue;
      }
      const today = quotes[quotes.length - 2];
      const tomorrow = quotes[quotes.length - 1];
      const up = tomorrow.close > today.close;
      const pctMove = (tomorrow.close - today.close) / today.close; // signed

      // 3) Score correctness
      const expectedUp = pred.label === 'buy';
      const expectedDown = pred.label === 'sell';
      const isFlat = Math.abs(pctMove) < holdTolerancePct;

      const correctPred =
        (expectedUp && up && !isFlat) ||
        (expectedDown && !up && !isFlat) ||
        (pred.label === 'hold' && isFlat);

      total += 1;
      if (correctPred) correct += 1;

      const arrow = up ? '↑' : '↓';
      console.log(
        `pred=${pred.label.padEnd(4)} | move=${arrow} ${(pctMove*100).toFixed(2)}% | ${correctPred ? '✅' : '❌'}`
      );
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  const accuracy = total ? ((correct / total) * 100).toFixed(2) : 'NaN';
  console.log(`\n✅ Ensemble accuracy on ${total} samples: ${accuracy}%`);
}

// --- CLI args (optional): --days 30 --symbols MSFT,AAPL,NVDA,AMD
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  const k = args[i];
  const v = args[i + 1];
  if (k === '--days') opts.days = parseInt(v, 10);
  if (k === '--symbols') opts.symbols = v.split(',').map(s => s.trim()).filter(Boolean);
}

testAccuracy(opts);

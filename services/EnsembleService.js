// backend/services/EnsembleService.js
const { getTechnical } = require('./TechnicalService');
const { predictNextDay } = require('./formula3');  // ← add this import

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

async function getEnsemblePrediction(symbol, opts = {}) {
  // Reuse TechnicalService to fetch a 1y daily package (already robust)
  const tech = await getTechnical(symbol, { profile: opts.profile });

  // If we couldn’t get enough history, fall back to hold/neutral
  const daily = Array.isArray(tech?.technical) ? tech.technical : [];
  if (!daily.length) {
    return {
      symbol,
      label: 'hold',
      prob: 0.5,
      confidence: 0.0,
      features: null,
      rationale: ['Insufficient daily history.'],
      technical: tech,
    };
  }

  // Map TechnicalService rows → formula3 candles input
  const candles = daily.map(r => ({
    t: r.date,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0
  }));

  // Optional externals (you can wire real series later)
  const inputs = {
    candles,
    sentiment: Array(candles.length).fill({ score: 0 }),
    impliedVol: Array(candles.length).fill(NaN),
    vix: Array(candles.length).fill(NaN),
    epu: Array(candles.length).fill(NaN),
    mdd: Array(candles.length).fill(NaN),
    mode: 'during',
  };

  // Run YOUR formula
  const out = predictNextDay(inputs);
  // Map to ensemble shape
  const labelMap = { Up: 'buy', Down: 'sell', Neutral: 'hold' };
  const label = labelMap[out.prediction.label] || 'hold';
  const prob  = clamp01(out.prediction.probUp);       // already [0,1]
  // confidence ≈ distance from 0.5 (simple, can refine)
  const confidence = clamp01(Math.abs(prob - 0.5) / 0.5);

  const rationale = [
    `SCI score=${out.snapshot.score?.toFixed(3) ?? 'n/a'}`,
    `probUp=${out.prediction.probUp}`,
    `expMag=${out.prediction.expectedMagnitude}`,
  ];

  return {
    symbol,
    label,               // 'buy' | 'sell' | 'hold'
    prob,                // probability of Up from your model
    confidence,
    features: out.snapshot,   // pass snapshot for UI/debug
    rationale: rationale.length ? rationale : ['SCI mixed'],
    technical: tech,          // still expose for charts
  };
}

module.exports = { getEnsemblePrediction };

// backend/scripts/test-formula3.js
const { runFullFormula, predictNextDay } = require('../services/formula3');

function genDummy(n=200) {
  const candles = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const t = `2025-01-${String(i+1).padStart(2,'0')}`;
    const ch = (Math.random()-0.5) * 2;
    const open = p;
    p = Math.max(1, p * (1 + ch/100));
    const close = p;
    const high = Math.max(open, close) * (1 + 0.005);
    const low = Math.min(open, close) * (1 - 0.005);
    const volume = 1_000_000 * (1 + Math.random());
    candles.push({ t, open, high, low, close, volume });
  }
  const mk = Array(n).fill(0).map(()=>100+Math.random()*5);
  return {
    candles,
    sentiment: candles.map(_ => ({ t: _.t, score: (Math.random()-0.5) })), // -0.5..0.5
    impliedVol: candles.map(_ => 0.3 + Math.random()*0.05),
    vix: mk.map(x=>x + (Math.random()-0.5)*2),
    epu: mk.map(x=>x + (Math.random()-0.5)*2),
    mdd: mk.map(x=>x + (Math.random()-0.5)*2),
  };
}

const inputs = genDummy();
const out = runFullFormula(inputs);
console.log('BEST COMBO:', out.bestCombo);
console.log('SNAPSHOT:', out.snapshot);

const pred = predictNextDay(inputs);
console.log('PREDICTION:', pred.prediction);

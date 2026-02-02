// backend/routes/formula3-symbol.js
const express = require('express');
const router = express.Router();
const yf = require('yahoo-finance2').default;
const { predictNextDay } = require('../services/formula3');

// GET /api/formula3/run-symbol/:symbol?months=6&mode=during
router.get('/run-symbol/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const monthsBack = Math.max(1, Math.min(24, +(req.query.months || 6)));
    const mode = (req.query.mode === 'after') ? 'after' : 'during';

    // fetch ~monthsBack months of daily candles
    const period2 = new Date();
    const period1 = new Date(period2.getTime() - monthsBack * 30 * 24 * 60 * 60 * 1000);
    const ch = await yf.chart(symbol, { period1, period2, interval: '1d' });

    const candles = (ch?.quotes || []).map(q => ({
      t: q.date.toISOString().slice(0,10),
      open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
    })).filter(r => Number.isFinite(r.close));

    if (candles.length < 60) {
      return res.json({
        prediction: { label: 'Neutral', probUp: 0.5, expectedMagnitude: 0 },
        snapshot:   { reason: 'insufficient_candles', n: candles.length }
      });
    }

    const N = candles.length;
    const inputs = {
      candles,
      sentiment: Array(N).fill({ score: 0 }), // neutral sentiment
      impliedVol: Array(N).fill(NaN),         // unknown IV → treated as 0 in TVol
      vix: Array(N).fill(NaN),                // optional macro vols (omit safely)
      epu: Array(N).fill(NaN),
      mdd: Array(N).fill(NaN),
      mode,
      dayRows: null                           // we can add true dayRows later
    };

    const out = predictNextDay(inputs);
    return res.json(out);
  } catch (err) {
    console.error('run-symbol error:', err);
    res.status(500).json({ message: 'run-symbol failed' });
  }
});

module.exports = router;

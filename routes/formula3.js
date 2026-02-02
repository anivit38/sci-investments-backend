// backend/routes/formula3-symbol.js
const express = require('express');
const router = express.Router();
const { historicalCompat } = require('../lib/yfCompat');   // <— use your compat
const { predictNextDay } = require('../services/formula3');

// GET /api/formula3/run-symbol/:symbol?months=6&mode=during
router.get('/run-symbol/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const monthsBack = Math.max(1, Math.min(24, +(req.query.months || 6)));
  const mode = (req.query.mode === 'after') ? 'after' : 'during';

  try {
    // dates for ~N months back
    const period2 = new Date();
    const period1 = new Date(period2.getTime() - monthsBack * 30 * 24 * 60 * 60 * 1000);

    // use compat wrapper → {date,open,high,low,close,volume}[]
    const rows = await historicalCompat(symbol, { period1, period2, interval: '1d' });

    const candles = rows
      .map(r => ({
        t: (typeof r.date === 'string') ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0,10),
        open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0
      }))
      .filter(r => Number.isFinite(r.close));

    if (candles.length < 60) {
      return res.json({
        prediction: { label: 'Neutral', probUp: 0.5, expectedMagnitude: 0 },
        snapshot:   { reason: 'insufficient_candles', n: candles.length, symbol }
      });
    }

    const N = candles.length;
    const inputs = {
      candles,
      sentiment: Array(N).fill({ score: 0 }),
      impliedVol: Array(N).fill(NaN),
      vix: Array(N).fill(NaN),
      epu: Array(N).fill(NaN),
      mdd: Array(N).fill(NaN),
      mode,
      dayRows: null
    };

    const out = predictNextDay(inputs);
    return res.json(out);
  } catch (err) {
    console.error('[/api/formula3/run-symbol] error for', symbol, err?.message, err?.stack);
    res.status(500).json({ message: 'run-symbol failed', error: String(err?.message || err) });
  }
});

module.exports = router;

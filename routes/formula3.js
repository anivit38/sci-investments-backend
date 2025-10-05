// backend/routes/formula3.js
const express = require('express');
const router = express.Router();
const { runFormula3 } = require('../services/formula3');

// POST /api/formula3/run
// Body: { candles:[{t,open,high,low,close,volume}], sentiment:[{t,score}], impliedVol:[], vix:[], epu:[], mdd:[] }
router.post('/run', async (req, res) => {
  try {
    const out = runFormula3(req.body);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

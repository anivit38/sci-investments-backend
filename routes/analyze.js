// backend/routes/analyze.js
const express = require('express');
const path = require('path');
const router = express.Router();
const FundamentalsService = require('../services/FundamentalsService');

// ─── Load industryMetrics.json from the project root ────────────────────────
const industryMetrics = require(path.join(__dirname, '..', 'industryMetrics.json'));

/**
 * POST /api/analyze-stock
 * Body: { symbol, depth, type, intent }
 */
router.post('/analyze-stock', async (req, res) => {
  try {
    const { symbol, depth, type, intent } = req.body;
    if (!symbol || !type) {
      return res.status(400).json({ message: 'symbol & type required' });
    }

    const result = { symbol };

    if (type === 'fundamental') {
      result.fundamentals = await FundamentalsService.getFundamentals(symbol);

      // (Optionally) include your static industry metrics here:
      // e.g. result.industryBenchmarks = industryMetrics[symbol] || null;
    } else {
      // TODO: call TechnicalsService when ready
      result.technicals = null;
    }

    return res.json(result);
  } catch (err) {
    console.error('analyze-stock error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

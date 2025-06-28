// backend/routes/analyze.js
const express = require('express');
const router = express.Router();
const FundamentalsService = require('../services/FundamentalsService');

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

    let result = { symbol };

    if (type === 'fundamental') {
      result.fundamentals = await FundamentalsService.getFundamentals(symbol);
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

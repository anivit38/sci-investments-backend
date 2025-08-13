 const express      = require('express');
 const axios        = require('axios');
 const authenticate = require('../middleware/auth');
 const router       = express.Router();
  const { getRecommendation } = require('../services/FinancialAdvisorService');
// — POST /api/advisor/chat —————————————————————————————
// Body: { symbol: string, prompt: string }
router.post(
  '/advisor/chat',
  authenticate,          // ← protect this route
  async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  // — make sure these are ASCII hyphens (U+002D), not non‑breaking ones! —
  const cfUrl =
    process.env.NODE_ENV === 'development'
      ? 'http://127.0.0.1:5001/sci-investments/us-central1/chatAI'
      : 'https://us-central1-sci-investments.cloudfunctions.net/chatAI';

  try {
    // symbol="N/A" tells onboardAI to skip fundamentals if you choose
    const cfResp = await axios.post(cfUrl, { symbol: 'N/A', prompt })
    return res.json({ text: cfResp.data.text })
  } catch (err) {
    console.error('advisor/chat → CF error:', err.response?.data || err.message)
    const status  = err.response?.status || 500
    const message = err.response?.data?.error  || err.message
    return res.status(status).json({ error: message })
  }
})

// ... your GET /advisor/recommend stays the same ...



// — GET /api/advisor/recommend —————————————————————————
// Query: ?userId=xxx&symbol=YYY
// Returns whatever getRecommendation() gives you
router.get('/advisor/recommend', async (req, res) => {
  try {
    const { userId, symbol } = req.query;
    if (!userId || !symbol) {
      return res.status(400).json({ error: 'userId & symbol required' });
    }

    const rec = await getRecommendation(userId, symbol);
    return res.json(rec);
  } catch (err) {
    console.error('advisor/recommend error:', err);
    return res.status(500).json({ error: err.message });
  }
});


// … your existing POST /advisor/chat and GET /advisor/recommend …

// GET /api/advisor/research/:symbol
router.get(
  '/advisor/research/:symbol',
  authenticate,
  async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
      const docs = await getTopKReferences(symbol, 5);
      // map to title/content shape
      return res.json(docs.map(d => ({ title: d.title, content: d.content })));
    } catch (err) {
      console.error('advisor/research error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/price/:symbol
router.get(
  '/price/:symbol',
  authenticate,
  async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
      const { price, timestamp } = await getLivePrice(symbol);
      return res.json({ price, timestamp });
    } catch (err) {
      console.error('price error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;


module.exports = router;
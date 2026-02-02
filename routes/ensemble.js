// backend/routes/ensemble.js
const express = require('express');
const router = express.Router();
const { getEnsemblePrediction } = require('../services/EnsembleService');

// Flip-guard memory: remembers last decisions per symbol (in-memory)
const LAST_DECISION = new Map();

// Tunables
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h between flips
const MIN_MARGIN  = 0.15;               // new prob must beat old by 15%
const MIN_CONF    = 0.65;               // require 65% to allow a flip

function applyFlipGuard(symbol, base) {
  const prev = LAST_DECISION.get(symbol);
  const now = Date.now();

  let finalLabel = base.label;
  let finalProb = base.prob;
  let finalRationale = Array.isArray(base.rationale) ? base.rationale.slice() : [];

  if (prev) {
    const same = prev.label === base.label;
    const flipTooSoon =
      !same &&
      (now - prev.ts < COOLDOWN_MS) &&
      (base.prob < MIN_CONF || (base.prob - (prev.prob ?? 0)) < MIN_MARGIN);

    if (flipTooSoon) {
      finalLabel = prev.label;
      finalProb = prev.prob;
      finalRationale.push('Flip-guard held previous label to prevent whipsaw');
    }
  }

  const guarded = {
    ...base,
    label: finalLabel,
    prob: finalProb,
    rationale: finalRationale,
  };

  LAST_DECISION.set(symbol, { label: guarded.label, prob: guarded.prob, ts: now });
  return guarded;
}

/**
 * GET /api/ensemble/predict/:symbol
 * Example: /api/ensemble/predict/MSFT?lite=1
 */
router.get('/predict/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const full = await getEnsemblePrediction(symbol, { profile: null });

    // Apply flip-guard first
    const guarded = applyFlipGuard(symbol, {
      symbol: full.symbol,
      label: full.label,
      prob: full.prob,
      confidence: full.confidence,
      rationale: full.rationale || [],
      // expose any extras your UI uses:
      trend: full.features?._meta?.trend ?? null,
      levels: full.features?._meta?.levels ?? null,
      features: full.features, // keep original if you return full
    });

    res.set('Cache-Control', 'no-store');

    if (req.query.lite === '1') {
      // Lite response
      return res.json({
        symbol: guarded.symbol,
        label: guarded.label,
        prob: guarded.prob,
        confidence: guarded.confidence,
        rationale: guarded.rationale,
        trend: guarded.trend,
        levels: guarded.levels,
      });
    }

    // Full response (override label/prob/rationale so callers see guarded decision)
    return res.json({
      ...full,
      label: guarded.label,
      prob: guarded.prob,
      rationale: guarded.rationale,
      flipGuard: { cooldownMs: COOLDOWN_MS, minMargin: MIN_MARGIN, minConf: MIN_CONF },
    });
  } catch (e) {
    console.error('ensemble/predict GET:', e);
    res.status(500).json({ message: 'predict failed' });
  }
});

/**
 * POST /api/ensemble/predict/:symbol
 * Example body: { "profile": { "riskTolerance": "high" } }
 */
router.post('/predict/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const profile = req.body?.profile || null;
    const full = await getEnsemblePrediction(symbol, { profile });

    const guarded = applyFlipGuard(symbol, {
      symbol: full.symbol,
      label: full.label,
      prob: full.prob,
      confidence: full.confidence,
      rationale: full.rationale || [],
      trend: full.features?._meta?.trend ?? null,
      levels: full.features?._meta?.levels ?? null,
      features: full.features,
    });

    res.set('Cache-Control', 'no-store');
    return res.json({
      ...full,
      label: guarded.label,
      prob: guarded.prob,
      rationale: guarded.rationale,
      flipGuard: { cooldownMs: COOLDOWN_MS, minMargin: MIN_MARGIN, minConf: MIN_CONF },
    });
  } catch (e) {
    console.error('ensemble/predict POST:', e);
    res.status(500).json({ message: 'predict failed' });
  }
});

module.exports = router;

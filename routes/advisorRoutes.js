// routes/advisorRoutes.js
const express = require('express');
const router = express.Router();

const UserProfile = require('../models/UserProfile');

// Turn the generic/raw signal into a short baseline sentence
function genericLine(raw = {}) {
  if (raw.advice) return String(raw.advice);
  if (raw.classification === 'growth') return 'Projected to grow — buy/accumulate on pullbacks.';
  if (raw.classification === 'stable') return 'Stable outlook — hold or nibble on dips.';
  if (raw.classification === 'unstable') return 'Projected to decline — avoid or reduce exposure.';
  return 'No generic signal available.';
}

async function getUserId(req) {
  // Prefer Firebase token if present; fall back to header (front-end already sends x-user-id)
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const idToken = header.split(' ')[1];
      const decoded = await admin.auth().verifyIdToken(idToken);
      return decoded.uid;
    } catch (_) {}
  }
  return req.headers['x-user-id'] || null;
}

router.post('/advisor/suggest', async (req, res) => {
  try {
    const { symbol, raw } = req.body || {};
    if (!symbol) return res.status(400).json({ message: 'symbol required' });

    // Try to identify the user (either authenticated middleware or header fallback)
    const userId = await getUserId(req);

    // Pull the user’s saved onboarding profile if available
    let profile = null;
    if (userId) {
      profile = await UserProfile.findOne({ userId }).lean().catch(() => null);
    }

    // Simple, transparent “personalization” using the data we already have
    const m = raw?.metrics || {};
    const flags = [];
    if (m.debtRatio != null && m.debtRatio > 1) flags.push('High leverage (Debt/Equity > 1)');
    if (m.earningsGrowth != null && m.earningsGrowth < 0) flags.push('Negative earnings growth');
    if (m.peRatio != null && m.peRatio > 40) flags.push('Rich valuation (P/E > 40)');

    const base = genericLine(raw);
    const highlights = [];
    const tags = [];

    let message = base;

   // Normalize profile fields we care about
   const risk  = String(profile?.riskTolerance || 'moderate').toLowerCase(); // very_low…very_high, low/moderate/high supported
   const horiz = String(profile?.investmentHorizon || profile?.horizon || 'long-term').toLowerCase();
   const goals = Array.isArray(profile?.goals) ? profile.goals.map(g => g.toLowerCase()) : [];
   const sectors = Array.isArray(profile?.sectors) ? profile.sectors : [];
   const divYld = Number(m.dividendYield ?? 0);
   const debt   = Number(m.debtRatio ?? 0);
   const price  = Number(m.currentPrice ?? 0);

   // Personal guardrails
   if (profile?.maxPositionPct) highlights.push(`Cap position at ~${profile.maxPositionPct}%`);
   if (profile?.stopLossPct)    highlights.push(`Consider stop-loss near ${profile.stopLossPct}%`);

   // Goal alignment
   if (goals.includes('income')) {
     if (divYld > 0) { highlights.push(`Supports income goal (dividend ≈ ${divYld}%)`); }
     else            { highlights.push('No dividend — may not suit your income goal'); }
   }
   if (goals.includes('growth') && raw?.classification === 'growth') {
     highlights.push('Aligned with growth objective');
   }

   // Risk × classification × leverage
   if ((risk === 'very_low' || risk === 'low') && raw?.classification === 'unstable') {
     message = 'Avoid or reduce — volatility and drawdown risk don’t fit your risk profile.';
   }
   if (debt > 1 && (risk === 'very_low' || risk === 'low')) {
     highlights.push('Leverage may be too high for conservative risk');
   }

   // Horizon nudges
   if (horiz.includes('short')) {
     highlights.push('Short horizon — prefer liquid names and tighter risk controls');
     if (raw?.classification !== 'growth') {
       message = 'Hold / wait — short horizon + weak setup reduce edge.';
     }
   } else {
     highlights.push('Longer horizon allows dollar-cost averaging on pullbacks');
   }

   // Holdings context (if user already holds it)
   const pos = (profile?.holdings || []).find(h => h.symbol?.toUpperCase() === symbol.toUpperCase());
   if (pos && price) {
     const pnl = ((price - pos.avgPrice) / pos.avgPrice) * 100;
     const dir = pnl >= 0 ? '▲' : '▼';
     highlights.push(`You already hold ${pos.quantity} shares @ $${pos.avgPrice.toFixed(2)} (${dir} ${pnl.toFixed(1)}%)`);
     if (profile?.maxPositionPct) {
       highlights.push(`Avoid adding above ${profile.maxPositionPct}% allocation cap`);
     }
   }

   // Tags for the UI chip row
   if (risk)   tags.push(`Risk: ${risk}`);
   if (horiz)  tags.push(`Horizon: ${horiz}`);
   if (sectors?.length) tags.push(...sectors.slice(0,3));

   // Generic risk notes when not signed in
   if (!profile && flags.length) highlights.push(`Risk notes: ${flags.join(', ')}`);

    return res.json({
      message: profile
        ? `${message} (tailored to your ${risk} risk and ${horiz} horizon).`
        : `${message} (generic — sign in & complete profile for a tailored plan).`,
      highlights,
      tags,
      risk: flags.join('; ') || undefined,
    });
  } catch (err) {
    console.error('advisor/suggest:', err);
    return res.status(500).json({ message: err.message });
  }
});

module.exports = router;

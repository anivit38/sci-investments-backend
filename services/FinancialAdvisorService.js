// backend/services/FinancialAdvisorService.js
const axios = require('axios');
const UserProfile         = require('../models/UserProfile');
const { getFundamentals } = require('./FundamentalsService');
const { getTechnical }    = require('./TechnicalService');

async function getRecommendation(userId, symbol) {
  // 1) Load user profile
  const profile = await UserProfile.findOne({ userId });
  if (!profile) throw new Error('User profile not found');

  // 2) Fetch data
  const fundamental = await getFundamentals(symbol);
  const pe = fundamental.ratios.peRatio;
  const technical   = await getTechnical(symbol);

  // 3) Simple decision logic
  let action, reason;
  if (profile.riskTolerance === 'high') {
    action = technical.signal;
    reason = `Technical ${technical.primaryIndicator} shows a ${technical.signal} signal.`;
  } else {
    action = pe < 20 ? 'buy' : 'hold';
    reason = pe < 20
      ? `PE ratio (${pe}) is below 20, indicating potential undervaluation.`
      : `PE ratio (${pe}) is above 20, suggesting it may be overvalued.`;
  }

  // 4) Return all data + your recommendation
  return {
    symbol,
    action,
    reason,
    fundamental,
    technical
  };
}

async function chatWithAdvisor(userId, message) {
  // build payload
  const payload = { userId, prompt: message };

  // switch between emulator URL and production URL
  const fnUrl = process.env.NODE_ENV === 'development'
    ? 'http://localhost:5001/sci‑investments/us-central1/chatAI'
    : 'https://us-central1-sci‑investments.cloudfunctions.net/chatAI';

  const { data } = await axios.post(fnUrl, payload);
  // expect { text: "…your AI reply…" }
  return { text: data.text };
}

module.exports = {
  getRecommendation,
  chatWithAdvisor
};

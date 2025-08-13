require('dotenv').config();
const axios = require('axios');
const Fundamentals = require('../models/Fundamentals');  // your Mongoose model
const { computeRatios } = require('./transformFundamentals');

const BASE   = 'https://www.alphavantage.co/query';
const AV_KEY = process.env.ALPHA_VANTAGE_KEY;

async function pullCompanyFundamentals(symbol) {
  try {
    // 1) Fetch all four endpoints in parallel
    const funcs = ['OVERVIEW','INCOME_STATEMENT','BALANCE_SHEET','CASH_FLOW'];
    const urls  = funcs.map(fn => `${BASE}?function=${fn}&symbol=${symbol}&apikey=${AV_KEY}`);
    const [overviewRes, incomeRes, balanceRes, cashRes] = await Promise.all(urls.map(u => axios.get(u)));

    // 2) Bundle raw data
    const raw = {
      overview: overviewRes.data,
      income:   incomeRes.data,
      balance:  balanceRes.data,
      cashflow: cashRes.data,
    };

    // 3) Compute ratios
    const ratios = computeRatios(raw);

    // 4) Upsert into MongoDB
    await Fundamentals.findOneAndUpdate(
      { symbol },
      { $set: { fetchedAt: new Date(), raw, ratios } },
      { upsert: true, new: true }
    );

    console.log(`✔️  Saved fundamentals for ${symbol}`);
  } catch (err) {
    console.error(`❌ Error pulling fundamentals for ${symbol}:`, err.message);
  }
}

module.exports = { pullCompanyFundamentals };

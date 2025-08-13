// backend/models/Fundamentals.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const FundamentalsSchema = new Schema({
  symbol: {
    type: String,
    required: true,
    unique: true
  },
  fetchedAt: {
    type: Date,
    required: true
  },
  raw: {
    type: Schema.Types.Mixed,
    default: {}
  },
  ratios: {
    type: Schema.Types.Mixed,
    default: {}
  }
});

module.exports = mongoose.model('Fundamentals', FundamentalsSchema);
// This model represents the fundamentals data for a company,
// including raw data from Alpha Vantage and computed financial ratios. 
const mongoose = require('mongoose');

const holdingSchema = new mongoose.Schema({
  symbol:    { type: String, required: true },
  quantity:  { type: Number, required: true },
  avgPrice:  { type: Number, required: true }
});

const cashFlowSchema = new mongoose.Schema({
  monthlyIncome:   { type: Number, required: true },
  monthlyExpenses: { type: Number, required: true }
});

const userProfileSchema = new mongoose.Schema({
  userId:            { type: String, required: true, unique: true },
  name:              { type: String },
  age:               { type: Number },
  income:            { type: Number },
  riskTolerance:     { type: String, enum: ['low','moderate','high'] },
  investmentHorizon: { type: String, enum: ['short-term','long-term'] },
  goals:             [String],
  preferredAssets:   [String],
  cashFlow:          cashFlowSchema,
  holdings:          [holdingSchema]
});

module.exports = mongoose.model('UserProfile', userProfileSchema);

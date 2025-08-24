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
  riskTolerance:     { type: String, enum: ['very_low','low','moderate','high','very_high'], default: 'moderate' },
  investmentHorizon: { type: String, enum: ['short-term','medium-term','long-term'], default: 'long-term' },
  goals:             [String],
  preferredAssets:   [String],
  cashFlow:          cashFlowSchema,
  holdings:          [holdingSchema],


   // onboarding extras (match /api/completeOnboarding)
 experience:        { type: String },
 horizon:           { type: String },        // alias the field name you already send
 portfolioSize:     { type: Number },
 incomeRange:       { type: String },
 investPct:         { type: Number },
 currentAge:        { type: Number },
 retireAge:         { type: Number },
 retireIncome:      { type: Number },
 sectors:           [String],
 notes:             { type: String },

 // guardrails/preferences
 maxPositionPct:    { type: Number },
 stopLossPct:       { type: Number },
 ethicalExclusions: [String],
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('UserProfile', userProfileSchema);

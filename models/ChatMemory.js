const mongoose = require('mongoose');

const ChatMemorySchema = new mongoose.Schema({
  userId:   { type: String, index: true, unique: true },
  facts: {
    riskTolerance: String,
    horizon: String,
    maxPositionPct: Number,
    stopLossPct: Number,
    watchlist: [String],
    sectorLimits: { type: Object, default: {} },
    notes: String
  },
  summary:   String,
  updatedAt: Date
});

module.exports = mongoose.model('ChatMemory', ChatMemorySchema);

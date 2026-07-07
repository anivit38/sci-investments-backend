// cache.js — shared per-symbol cache for the quant layer.
//
// In-memory only (Map), scoped to this Node process's lifetime. The spec's
// "lazy per-stock, 15-day" cadence (§6.3) doesn't specify persistence across
// server restarts — worth revisiting if this deploys behind multiple
// instances or restarts frequently, since each restart resets the heartbeat.
// Not one of the 11 owner-decision items, just an implementation note.

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;

const validationCache = new Map(); // symbol -> { lastRun, edge, hitRate, folds, holdout, isRunning }

function getValidation(symbol) {
  return validationCache.get(symbol) || null;
}

function isFresh(entry) {
  return !!entry && (Date.now() - entry.lastRun) < FIFTEEN_DAYS_MS;
}

function setValidation(symbol, result) {
  validationCache.set(symbol, { ...result, lastRun: Date.now(), isRunning: false });
}

function markRunning(symbol) {
  const existing = validationCache.get(symbol);
  if (existing) validationCache.set(symbol, { ...existing, isRunning: true });
  else validationCache.set(symbol, { isRunning: true, lastRun: 0, edge: 'unknown', hitRate: null, folds: 0, holdout: null });
}

function isRunning(symbol) {
  return !!validationCache.get(symbol)?.isRunning;
}

module.exports = { getValidation, isFresh, setValidation, markRunning, isRunning, FIFTEEN_DAYS_MS };

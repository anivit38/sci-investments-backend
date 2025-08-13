// services/PositionSizingService.js
// Turns a signal (entry & stop) + user/profile settings into a concrete share qty.
// CommonJS module to match the rest of your codebase.

function parseDollars(input, fallback = 0) {
  if (input == null) return fallback;
  if (typeof input === 'number' && isFinite(input)) return input;

  let s = String(input).trim().toLowerCase().replace(/[\$,]/g, '');
  if (!s) return fallback;

  // Support 100k / 2.5m shorthands
  const mul = s.endsWith('k') ? 1e3 : s.endsWith('m') ? 1e6 : 1;
  if (mul !== 1) s = s.slice(0, -1);

  const n = Number(s);
  return isFinite(n) ? n * mul : fallback;
}

// Accepts "1%", "0.5", 1, 0.5, "2 pct", etc.
function parsePercent(input, fallback = 0.01) {
  if (input == null) return fallback;

  if (typeof input === 'number' && isFinite(input)) {
    if (input <= 0) return fallback;
    // If they pass 0–1 treat as fraction; if 1–100 treat as percent
    return input <= 1 ? input : input / 100;
  }

  const s = String(input).toLowerCase().replace(/\s/g, '');
  const m = s.match(/^([0-9]*\.?[0-9]+)(%|pct)?$/);
  if (!m) return fallback;

  const val = Number(m[1]);
  if (!isFinite(val) || val <= 0) return fallback;
  const hasPct = Boolean(m[2]);
  return hasPct ? val / 100 : (val <= 1 ? val : val / 100);
}

// Map loose risk words to a per-trade risk fraction
function riskPctFromTolerance(tol) {
  if (!tol) return 0.01; // default 1%
  const t = String(tol).toLowerCase();
  if (/(low|conservative|very\s*low)/.test(t)) return 0.005;  // 0.5%
  if (/(high|aggressive|very\s*high)/.test(t)) return 0.02;   // 2.0%
  return 0.01; // medium / balanced
}

/**
 * Core position sizing calculator.
 * @param {Object} params
 * @param {'long'|'short'} [params.side='long']
 * @param {number} params.entry - planned entry price
 * @param {number} [params.stop] - protective stop price; if missing, will try ATR fallback
 * @param {number} params.accountSize - total account equity ($)
 * @param {number} [params.riskPctPerTrade=0.01] - fraction of equity to risk per trade (e.g., 0.01 = 1%)
 * @param {number} [params.maxPositionPct=0.2] - cap by position value vs equity (e.g., 0.2 = 20%)
 * @param {number} [params.volatilityATR] - ATR(14) or similar for fallback stop sizing
 * @param {number} [params.atrFallbackMult=1.2] - if stop invalid, use entry ± ATR*mult
 * @param {number} [params.lotSize=1] - round to this lot size (1 for US stocks)
 * @param {number} [params.minQty=1] - minimum quantity to place an order
 */
function sizePosition(params) {
  const {
    side = 'long',
    entry,
    stop: stopIn,
    accountSize,
    riskPctPerTrade = 0.01,
    maxPositionPct = 0.2,
    volatilityATR,
    atrFallbackMult = 1.2,
    lotSize = 1,
    minQty = 1,
  } = params || {};

  if (!isFinite(entry) || entry <= 0) {
    return { qty: 0, reason: 'Invalid entry price', ..._baseOut(params, null, null) };
  }
  if (!isFinite(accountSize) || accountSize <= 0) {
    return { qty: 0, reason: 'Invalid account size', ..._baseOut(params, null, null) };
  }

  let stop = stopIn;
  // Validate/repair stop using ATR fallback if necessary
  if (!isFinite(stop)) {
    if (isFinite(volatilityATR) && volatilityATR > 0) {
      stop = side === 'long' ? entry - volatilityATR * atrFallbackMult
                             : entry + volatilityATR * atrFallbackMult;
    }
  }
  // Ensure stop gives positive risk per share
  let riskPerShare =
    side === 'long' ? entry - stop
    : side === 'short' ? stop - entry
    : NaN;

  if (!isFinite(riskPerShare) || riskPerShare <= 0) {
    // Last-ditch: 1% price risk if nothing else available
    riskPerShare = Math.max(entry * 0.01, 0.01);
    stop = side === 'long' ? entry - riskPerShare : entry + riskPerShare;
  }

  const riskBudget = accountSize * Math.max(0, Math.min(1, riskPctPerTrade));
  let qtyByRisk = Math.floor(riskBudget / riskPerShare);

  // Cap by position value limit
  const maxPositionValue = accountSize * Math.max(0, Math.min(1, maxPositionPct));
  const qtyByCap = Math.floor(maxPositionValue / entry);

  let qty = Math.max(0, Math.min(qtyByRisk, qtyByCap));

  // Round to lot size
  if (lotSize > 1) qty = Math.floor(qty / lotSize) * lotSize;

  // Enforce minQty
  if (qty > 0 && qty < minQty) qty = 0;

  const positionValue = qty * entry;
  const riskAtQty = qty * riskPerShare;

  return {
    side,
    entry,
    stop,
    qty,
    lotSize,
    minQty,
    riskPerShare: round(riskPerShare, 4),
    riskBudget: round(riskBudget, 2),
    riskAtQty: round(riskAtQty, 2),
    maxPositionValue: round(maxPositionValue, 2),
    positionValue: round(positionValue, 2),
    cappedByRisk: qtyByRisk <= qtyByCap,
    cappedByValue: qtyByCap < qtyByRisk,
    reason: qty === 0 ? 'Position too small under risk/cap constraints' : 'OK',
  };
}

function _baseOut(params, riskPerShare, maxPositionValue) {
  return {
    side: params?.side || 'long',
    entry: params?.entry,
    stop: params?.stop,
    qty: 0,
    lotSize: params?.lotSize ?? 1,
    minQty: params?.minQty ?? 1,
    riskPerShare,
    riskBudget: 0,
    riskAtQty: 0,
    maxPositionValue,
    positionValue: 0,
    cappedByRisk: false,
    cappedByValue: false,
  };
}

// Convenience: build inputs from your UserProfile doc + a signal {price, stop}
function sizePositionFromProfile({ profile, signal, atr, overrides = {} }) {
  if (!signal || !isFinite(signal.price)) {
    return { qty: 0, reason: 'Missing/invalid signal.price' };
  }

  const accountSize = parseDollars(profile?.portfolioSize, 0);

  // If the profile has an "investPct" (how much of portfolio to deploy), use it as max cap
  const maxPositionPct = parsePercent(profile?.investPct ?? 0.2, 0.2);

  const riskPctPerTrade =
    overrides.riskPctPerTrade ??
    parsePercent(profile?.riskPctPerTrade, riskPctFromTolerance(profile?.riskTolerance));

  const lotSize = overrides.lotSize ?? 1;
  const minQty = overrides.minQty ?? 1;

  return sizePosition({
    side: overrides.side || 'long',
    entry: Number(signal.price),
    stop: isFinite(signal.stop) ? Number(signal.stop) : undefined,
    accountSize,
    riskPctPerTrade,
    maxPositionPct,
    volatilityATR: isFinite(atr) ? Number(atr) : undefined,
    atrFallbackMult: overrides.atrFallbackMult ?? 1.2,
    lotSize,
    minQty,
  });
}

function round(x, p) {
  if (!isFinite(x)) return x;
  const m = Math.pow(10, p || 0);
  return Math.round(x * m) / m;
}

module.exports = {
  sizePosition,
  sizePositionFromProfile,
  parseDollars,
  parsePercent,
  riskPctFromTolerance,
};

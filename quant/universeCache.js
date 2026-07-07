// universeCache.js — sector-relative base-rate median for the §4.2 gate (G1).
//
// G1 [OWNER-SET]: the gate threshold is the median Model-A pDown among
// stocks IN THE SAME SECTOR; if the sector has fewer than
// ownerConfig.G1_MIN_SECTOR_SIZE qualifying members, fall back to the
// whole-universe median instead.
//
// There is no pre-existing "universe" of stocks with precomputed pDown
// values anywhere in SCI (the quant layer is new), so this cache builds the
// universe organically: every real stock-check that successfully runs
// Model A records its (sector, pDown_A) here. The median is therefore
// "the current base rate among stocks SCI users have actually checked
// recently" — which is exactly what §4.2 asks for ("currently-typical"),
// not a fixed external index.
//
// Observations older than 15 days are excluded from the median computation,
// which is what gives the threshold its "refreshed every 15 days" behavior
// (§4.2) without needing a separate scheduled job — old data simply ages out
// as it's read.

const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const cfg = require('./ownerConfig');

const bySymbol = new Map(); // symbol -> { sector, pDownA, at } — one slot per symbol, latest observation wins

function recordObservation(symbol, sector, pDownA) {
  if (!Number.isFinite(pDownA)) return;
  bySymbol.set(symbol, { sector: sector || 'Unknown', pDownA, at: Date.now() });
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function freshObservations() {
  const now = Date.now();
  return [...bySymbol.values()].filter(o => (now - o.at) < FIFTEEN_DAYS_MS);
}

/**
 * @param {string} sector
 * @returns {{ median: number, n: number, usedFallback: boolean, universeN: number }}
 */
function getMedianFor(sector) {
  const fresh = freshObservations();
  const sameSector = fresh.filter(o => o.sector === (sector || 'Unknown'));

  if (sameSector.length >= cfg.G1_MIN_SECTOR_SIZE) {
    return { median: median(sameSector.map(o => o.pDownA)), n: sameSector.length, usedFallback: false, universeN: fresh.length };
  }

  // Thin-sector fallback: whole-universe median.
  if (fresh.length > 0) {
    return { median: median(fresh.map(o => o.pDownA)), n: fresh.length, usedFallback: true, universeN: fresh.length };
  }

  // Cold start: no observations recorded anywhere yet (first-ever quant check
  // on this deployment). cfg.G1_FALLBACK_MEDIAN is a bootstrap value only —
  // it stops being used the moment even one real observation exists.
  return { median: cfg.G1_FALLBACK_MEDIAN, n: 0, usedFallback: true, universeN: 0 };
}

module.exports = { recordObservation, getMedianFor };

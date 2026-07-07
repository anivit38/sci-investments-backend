// quant/index.js — orchestrator for the SCI Quant Prediction Layer.
//
// Additive only (SCI_QUANT_LAYER_SPEC.md prime directive #1): this module
// consumes existing outputs (regime model, decision score, historical rows)
// and appends a new `quant` result. It does not modify anything upstream of
// its own inputs. See server.js's single marked call site for the only
// integration point into the existing /api/check-stock route.
//
// All eleven owner decisions are resolved (see ownerConfig.js / OWNER_DECISIONS.md).

const { runModelA } = require('./modelA');
const { runModelB } = require('./modelB');
const { characterize } = require('./characterize');
const { runStress } = require('./stress');
const { runValidation } = require('./validate');
const { assembleExplanation } = require('./explain');
const { histogram } = require('./mathUtils');
const { getExtendedHistory, trailingLogReturns } = require('./historicalFetch');
const universeCache = require('./universeCache');
const cacheStore = require('./cache');
const cfg = require('./ownerConfig');

function regimeLabelFor(H, vr) {
  if (H > 0.60 && vr.regime === 'low-vol') return `Trending (H=${H.toFixed(2)}, ${vr.regime})`;
  if (H < 0.42 || vr.regime === 'high-vol') return `Mean-reverting (H=${H.toFixed(2)}, ${vr.regime})`;
  return `Transitional / Random walk (H=${H.toFixed(2)})`;
}

function unavailableResult(reason) {
  return { available: false, reason, horizonDays: 15 };
}

function insufficientHistoryResult(daysAvailable) {
  return {
    available: true,
    horizonDays: 15,
    verdict: 'insufficient_history',
    reason: `A1: quant analysis requires ~${cfg.A1_MIN_HISTORY_DAYS} trading days of history; this stock has ${daysAvailable}. Skipping the quant layer for this stock rather than running a partial model.`,
  };
}

/**
 * @param {string} symbol
 * @param {object} ctx
 * @param {Array}  ctx.historicalRows - chronological {date, open, high, low, close, volume}, same
 *                 source the existing pipeline already fetched (do not re-fetch)
 * @param {object} ctx.regimeSnapshot - { H, vr, logRet } captured from the existing
 *                 regime-detection step in server.js (see regimeSnapshot capture there)
 * @param {number} ctx.currentPrice
 * @param {string} [ctx.sector] - assetProfile.sector (falls back to industry, then 'Unknown')
 */
async function runQuantLayer(symbol, ctx) {
  const { historicalRows, regimeSnapshot, currentPrice, sector } = ctx || {};

  if (!regimeSnapshot || !currentPrice || !Array.isArray(historicalRows) || historicalRows.length < 60) {
    // Mirrors the existing regime-detection route's own >=60-day guard —
    // the quant layer cannot run without a regime read to consume at all.
    return unavailableResult('Insufficient price history for regime-conditioned simulation (needs 60+ days).');
  }

  // A1 [OWNER-SET]: hard gate at ~400 trading days — no quant layer run at
  // all below this, no partial/degraded model.
  if (historicalRows.length < cfg.A1_MIN_HISTORY_DAYS) {
    return insufficientHistoryResult(historicalRows.length);
  }

  const { H, vr, logRet } = regimeSnapshot;
  const currentRegime = vr.regime === 'high-vol' ? 'high-vol' : 'low-vol';
  const sectorKey = sector || 'Unknown';

  // ── Stage 1: GENERATE ────────────────────────────────────────────
  const resultA = runModelA({ logRet, vr, currentPrice });

  // B1 [OWNER-SET]: Model B draws from a trailing 5-year window, which the
  // existing pipeline's own ~2-year historicalRows doesn't cover — fetched
  // independently here (cached 15 days per symbol) rather than touching the
  // existing fetch.
  const extendedHistory = await getExtendedHistory(symbol);
  const logRetB = extendedHistory.logRet.length >= cfg.B1_BLOCK_SIZE_DAYS * 4
    ? trailingLogReturns(extendedHistory, cfg.B1_HISTORY_WINDOW_DAYS)
    : logRet; // extended fetch failed/thin — fall back to the same series Model A used rather than crash
  const resultB = runModelB({ logRet: logRetB, currentPrice });

  // ── Stage 2: CHARACTERIZE ────────────────────────────────────────
  const char = characterize(resultA, resultB, sectorKey);
  // Record this observation for future sector-relative medians (G1) — the
  // universe builds organically from real checks; see universeCache.js.
  universeCache.recordObservation(symbol, sectorKey, resultA.pDown);

  // ── Stage 3: STRESS ──────────────────────────────────────────────
  // S2's fail-line reuses char.thresholdMedian: the sector-relative median
  // "in effect at the time of the crisis" isn't obtainable (the quant layer
  // didn't exist in 2008/2020/2022 to have computed one), so the current
  // sector median is used as the best available proxy — see stress.js.
  const stress = runStress({
    currentPrice,
    regimeParams: resultA.regimeParams,
    transitionMatrix: resultA.transitionMatrix,
    currentRegime,
    thresholdMedian: char.thresholdMedian,
    extendedHistory,
  });

  // ── Stage 4: VALIDATE (lazy, per-stock, 15-day cache; async cold-start) ──
  // Uses the extended (up to 5yr) history for more walk-forward folds than
  // the ~2yr historicalRows would allow — more samples strengthens the
  // calibration test's read (this is also A1's stated reason for requiring
  // ~400 days: enough samples for calibration to mean something).
  const cached = cacheStore.getValidation(symbol);
  let validationView;
  if (cacheStore.isFresh(cached)) {
    validationView = { state: 'fresh', ...cached };
  } else {
    validationView = {
      state: 'revalidating',
      calibration: cached?.calibration ?? 'unknown',
      folds: cached?.folds ?? 0,
      lastRun: cached?.lastRun ?? null,
    };
    if (!cacheStore.isRunning(symbol)) {
      cacheStore.markRunning(symbol);
      const validationRows = extendedHistory.rows.length >= 200 ? extendedHistory.rows : historicalRows;
      // Fire-and-forget so the HTTP response doesn't wait on the backtest.
      // NOTE: runValidation is synchronous CPU work; setImmediate only defers
      // its *start* past this request's response, it doesn't parallelize it
      // onto another thread. A worker_thread would be the production-grade
      // fix if this becomes a real bottleneck — not attempted here.
      setImmediate(() => {
        try {
          const result = runValidation(validationRows);
          cacheStore.setValidation(symbol, result);
        } catch (e) {
          cacheStore.setValidation(symbol, { calibration: 'unknown', folds: 0, error: e.message });
        }
      });
    }
  }

  // Stress and validation failures downgrade with parity (§6.4 "parity with
  // stress failure — this parity is deliberate").
  const validationDowngrade = validationView.calibration === 'failed' ? cfg.S2_DOWNGRADE_FLAT : 0;
  const totalDowngrade = char.modelAgreement.confidenceDock + stress.confidenceDowngrade + validationDowngrade;
  const confidence = Math.max(0, cfg.C1_BASE_CONFIDENCE - totalDowngrade);

  let verdict = char.verdict; // 'pass' | 'fail'
  if (stress.result === 'downgraded' || validationView.calibration === 'failed') {
    verdict = verdict === 'fail' ? 'fail' : 'downgraded'; // never silently upgrades a fail, never a hard veto
  }

  const regimeLabel = regimeLabelFor(H, vr);
  const explanation = assembleExplanation({
    symbol,
    regimeLabel,
    pDownUsed: char.pDown.gatedValue,
    thresholdMedian: char.thresholdMedian,
    verdict,
    modelAgreement: {
      modelA: char.pDown.modelA,
      modelB: char.pDown.modelB,
      disagreementPts: char.modelAgreement.disagreementPts,
    },
    drawdownFlag: char.drawdownFlag,
    stress,
    validation: validationView,
  });

  return {
    available: true,
    horizonDays: 15,
    verdict,
    pDown: char.pDown,
    thresholdMedian: char.thresholdMedian,
    sectorRelative: char.sectorRelative,
    sectorSampleSize: char.sectorSampleSize,
    universeSampleSize: char.universeSampleSize,
    drawdownFlag: char.drawdownFlag,
    modelAgreement: char.modelAgreement,
    stress: {
      historical: stress.historical.episodes,
      hypothetical: stress.hypothetical,
      regimeForced: stress.regimeForced,
      result: stress.result,
      confidenceDowngrade: stress.confidenceDowngrade,
      message: stress.message,
    },
    validation: validationView,
    confidence,
    regime: { label: regimeLabel, hurst: +H.toFixed(3), volState: vr.regime },
    // F1 [OWNER-SET]: density curve on the frontend. Backend still sends a
    // compact server-side histogram (raw 10,000-length arrays never leave
    // the server, per prime directive #2) — the frontend smooths this into
    // a density-curve rendering rather than bars; see stock-checker.js.
    distribution: {
      histogramA: histogram(resultA.terminalReturns),
      histogramB: histogram(resultB.terminalReturns),
      samplePathsA: resultA.samplePaths,
      samplePathsB: resultB.samplePaths,
    },
    explanation: explanation.text,
  };
}

module.exports = { runQuantLayer };

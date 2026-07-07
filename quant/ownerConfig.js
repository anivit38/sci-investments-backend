// ownerConfig.js
//
// All eleven owner decisions from SCI_QUANT_LAYER_SPEC.md are RESOLVED as of
// the spec's [OWNER-SET] revision. These are locked methodology values, not
// placeholders — implement against them exactly, do not re-tune.
//
// The one remaining item is explicitly optional per the spec (§4.3's TODO):
// whether to add a "severe" tier above the locked "notable" drawdown level.
// It is NOT a blocking decision, so it is not treated as pending anywhere in
// the pipeline — see D1_SEVERE_PCT_OPTIONAL below.

module.exports = {
  // A1 [OWNER-SET] — below ~400 trading days of history, do not run the
  // quant layer at all (no partial/degraded model). Chosen so the HMM
  // transition read and the calibration test (§6.4) both have enough samples.
  A1_MIN_HISTORY_DAYS: 400,

  // B1 [OWNER-SET] — block bootstrap block size + history window.
  B1_BLOCK_SIZE_DAYS: 10,
  B1_HISTORY_WINDOW_DAYS: 5 * 252, // 5 trading years (~1260 days)

  // G1 [OWNER-SET] — sector-relative base-rate median; thin-sector fallback
  // to the whole-universe median when the sector has fewer than 8 qualifying
  // members. Refreshed on the same 15-day heartbeat as revalidation (§6.3).
  G1_MIN_SECTOR_SIZE: 8,
  G1_FALLBACK_MEDIAN: 0.5, // used only until the universe cache has ANY members at all

  // G2 [OWNER-SET] — the gated value is Model A's pDown only. Model B never
  // enters the pass/fail decision, only the disagreement/confidence math.

  // D1 [OWNER-SET] — 95th percentile of per-path max-drawdown (pooled across
  // both models' paths); "notable" above 15%.
  D1_PERCENTILE: 0.95,
  D1_NOTABLE_PCT: 15,
  // Optional, NOT owner-decided yet — spec explicitly leaves this open as a
  // "TODO(owner): optionally add a higher severe tier (e.g. >25%)". Left off
  // by default; flip on later without any other code change.
  D1_SEVERE_PCT_OPTIONAL: null, // e.g. 25 to enable a "severe" tier

  // C1 [OWNER-SET] — confidence is a 0-100 score. Disagreement dock triggers
  // above a 15pt gap: dock = (disagreementPts - 15) * 0.5, floored at 0.
  // (A 40pt gap docks ~12.5 points, matching the spec's worked example.)
  C1_BASE_CONFIDENCE: 100,
  C1_RAMP_START_PTS: 15,
  C1_DOCK_SLOPE: 0.5,

  // S1 [OWNER-SET] — three structurally different historical crises, replayed
  // as the STOCK'S OWN actual historical return sequence during each window
  // (not a market-index proxy, not a synthetic shock). If the stock's history
  // doesn't reach a given window (e.g. recent IPO), that episode is marked
  // not-applicable for that stock rather than fabricated.
  S1_EPISODES: [
    { id: '2008-gfc',   name: '2008 Financial Crisis', start: '2008-09-01', end: '2009-03-01' },
    { id: '2020-covid', name: '2020 COVID Crash',      start: '2020-02-15', end: '2020-04-15' },
    { id: '2022-rates', name: '2022 Rate Shock',       start: '2022-01-01', end: '2022-12-31' },
  ],

  // S2 [OWNER-SET] — a scenario "fails" if its stressed pDown crosses the
  // sector-relative median in effect at the time of the crisis. In practice
  // the only median obtainable is the CURRENT sector median (the quant layer
  // did not exist in 2008/2020/2022 to have computed one historically), so
  // that is used as the best available proxy — see stress.js for the note
  // at its exact point of use. On any failure(s), a single flat 10-point
  // confidence downgrade applies (not per-scenario-multiplied) plus the
  // historical/probabilistic fragility message — never a hard veto.
  S2_DOWNGRADE_FLAT: 10,
  S2_MESSAGE: 'This stock has historically been fragile during financial crises (e.g. 2008 / 2020 / 2022).',

  // V1 [OWNER-SET] — statistical calibration test: bin walk-forward predicted
  // pDown values, check whether the observed down-frequency in each bin falls
  // within that bin's confidence interval around the predicted probability.
  V1_BIN_EDGES: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
  V1_MIN_SAMPLES_PER_BIN: 5,
  V1_MIN_TOTAL_SAMPLES: 20, // below this, calibration read is 'unknown', not 'failed'
  V1_CONFIDENCE_Z: 1.645,   // ~90% two-sided Wilson interval

  // E1 [OWNER-SET] — Voice A (plain & warm) locked template lives in explain.js.

  // F1 [OWNER-SET] — terminal distribution visual = density curve (frontend,
  // public/stock-checker.js), reusing the site's existing --gain/--loss/
  // --primary-bright/--hairline color tokens.
};

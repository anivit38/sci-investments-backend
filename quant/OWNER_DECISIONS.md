# SCI Quant Layer — Resolved Decision Log

All eleven owner decisions from `SCI_QUANT_LAYER_SPEC.md` §11 are RESOLVED
and implemented exactly as specified. Nothing in the pipeline is a
placeholder anymore — see `quant/ownerConfig.js` for every locked constant.

| ID | Decision | Value | Where implemented |
|----|----------|-------|---------------------|
| A1 | Insufficient-history behavior | Below ~400 trading days, the quant layer does not run at all (no partial/degraded model) — returns `verdict: "insufficient_history"` | `quant/index.js` (`A1_MIN_HISTORY_DAYS` gate), `quant/ownerConfig.js` |
| B1 | Bootstrap block size + history window | 10-day blocks, trailing 5-year window | `quant/modelB.js`, `quant/historicalFetch.js` (extended fetch, since the existing ~2yr `historicalRows` doesn't reach 5 years) |
| G1 | Median universe + thin-sector rule | Sector-relative median; falls back to whole-universe median when the sector has <8 qualifying members | `quant/universeCache.js`, `quant/characterize.js` |
| G2 | Which pDown is gated | Model A only — Model B never enters the pass/fail decision | `quant/characterize.js` |
| D1 | Drawdown summary stat + level | 95th percentile of per-path max-drawdown (pooled across both models); "notable" above 15% | `quant/characterize.js` |
| C1 | Confidence scale + dock | 0–100 score; `dock = (disagreementPts - 15) × 0.5`, floored at 0 | `quant/characterize.js` |
| S1 | Historical replay set + method | 2008 GFC / 2020 COVID / 2022 rate shock, replayed as the **stock's own actual historical return sequence** during each window (not a market-index proxy, not synthetic) | `quant/stress.js`, `quant/historicalFetch.js` |
| S2 | Stress fail-line + response | Fails if stressed pDown crosses the sector-relative median; flat 10-point downgrade on any failure (not multiplied per scenario); historical/probabilistic message, never phrased as certainty | `quant/stress.js` |
| V1 | Edge definition | Statistical calibration test — bins walk-forward predicted pDown values, checks whether each bin's mean prediction falls within the Wilson confidence interval of its observed down-frequency | `quant/validate.js`, `wilsonInterval()` in `quant/mathUtils.js` |
| E1 | Explanation wording | Locked Voice A (plain & warm) template, mechanism-honesty rules enforced (never "switched on" a fat tail, never phrased as certainty, crisis fragility always historical) | `quant/explain.js` |
| F1 | Distribution chart | Density curve (not histogram bars), site's existing `--gain`/`--loss`/`--hairline` tokens | `public/stock-checker.js` (`quantDensitySvg`) |

## One explicitly optional item (not a blocking decision)

§4.3 leaves a second, higher "severe" drawdown tier as optional future work
("TODO(owner): optionally add a higher severe tier, e.g. >25%"). This is off
by default (`ownerConfig.D1_SEVERE_PCT_OPTIONAL = null`) and can be turned on
later by setting that one constant — no other code changes needed.

## Two honest interpretation notes (not new unspecified decisions — documented, not guessed)

- **S2's "median in effect at the time of the crisis"**: the quant layer
  didn't exist in 2008/2020/2022 to have computed a historical median back
  then, so the current sector-relative median is used as the best available
  proxy for the fail-line comparison. Noted at the exact point of use in
  `quant/stress.js`.
- **S1's historical replay for a deterministic single sequence**: replaying
  one real historical path yields one terminal return, not a probability
  distribution, so there's no "pDown" for historical replay in the same
  sense as the other stress types. Ending the replay below break-even is
  treated as the deterministic equivalent of crossing the fail-line (see the
  comment above `historicalReplay()` in `quant/stress.js`).

## What's real end-to-end (verified, not just implemented)

- Model A reuses the exact existing regime model (`services/regimeModel.js`,
  extracted byte-identical from the original check-stock route — existing
  Stock Checker behavior is unchanged).
- Model B is genuinely regime-blind (never imports the regime model).
- The 400-day gate, the calibration-test validator, the historical-replay
  stress test, the sector-relative median (with cold-start and thin-sector
  fallback), and the async cold-start have all been exercised with real
  (synthetic, since Yahoo Finance is rate-limited in this environment) data
  and produce sane, non-crashing output — see the smoke tests run during
  this implementation pass.
- Server-side only: no simulation/threshold/model logic ships to the
  browser — `renderQuantPanel`/`quantDensitySvg` only format numbers and
  strings the backend already computed.

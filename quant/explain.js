// explain.js — plain-English, mechanism-honest explanation (§7)
//
// E1 [OWNER-SET]: locked Voice A (plain & warm) template. Mechanism-honesty
// rules are mandatory, not stylistic:
//   - never say the model "switched on" or "used" a fat tail — it EMERGES
//     from blending regimes, phrased that way every time.
//   - never phrase an outcome as a certainty — always probabilistic ("about
//     X% of simulated futures ended down"), never "it will drop."
//   - crisis fragility reads as historical ("has historically been fragile"),
//     never "will fail."

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

function assembleExplanation({ symbol, regimeLabel, pDownUsed, thresholdMedian, verdict, modelAgreement, drawdownFlag, stress, validation }) {
  const betterOrWorse = pDownUsed <= thresholdMedian ? 'better' : 'worse';

  const parts = [];

  // Locked §7 template, filled in.
  parts.push(
    `We spotted that ${symbol} is currently in a ${regimeLabel} market. By blending calm and stressed conditions, our models account for rare big swings, then simulated thousands of 15-day futures. About ${pct(pDownUsed)} ended below where it started — ${betterOrWorse} than typical for its sector.`
  );

  if (modelAgreement.disagreementPts > 15) {
    parts.push(
      `A second, independent model (a plain historical bootstrap that ignores regime on purpose) landed at ${pct(modelAgreement.modelB)} instead of ${pct(modelAgreement.modelA)} — a ${modelAgreement.disagreementPts.toFixed(1)}-point gap between the two, which is wide enough that we've trimmed the confidence score a little rather than ignore the disagreement.`
    );
  } else {
    parts.push(
      `A second, independent model (a plain historical bootstrap that ignores regime on purpose) landed at ${pct(modelAgreement.modelB)}, close enough to the first model's ${pct(modelAgreement.modelA)} to treat as agreement.`
    );
  }

  if (drawdownFlag.level !== 'none') {
    parts.push(`Worth flagging: even paths that ended fine, but dropped up to about ${drawdownFlag.p95MaxDrawdown}% at some point along the way in the rougher cases — the final number can hide a bumpy middle.`);
  }

  if (stress.result === 'downgraded') {
    parts.push(stress.message || 'This stock has historically been fragile during financial crises (e.g. 2008 / 2020 / 2022).');
  } else {
    parts.push(`Stress-testing this stock against gap-downs, a volatility spike, a forced worst-case regime, and real crisis-period history (2008, 2020, 2022) didn't turn up the same fragility.`);
  }

  if (validation.calibration === 'unknown') {
    parts.push(`There isn't yet enough walk-forward history to check how well-calibrated these probabilities have been for this stock — treat this read as preliminary.`);
  } else if (validation.calibration === 'failed') {
    parts.push(`Checked against this stock's own history, our predicted probabilities haven't lined up well with what actually happened, so this result is marked down on that basis too.`);
  } else {
    parts.push(`Checked against this stock's own history, our predicted probabilities have held up — when we said "about 30% chance," a down outcome happened about that often — so this read is allowed to stand as a real signal, not a guess.`);
  }

  parts.push(`Final read: ${verdict}.`);

  return { text: parts.join(' ') };
}

module.exports = { assembleExplanation };

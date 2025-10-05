#!/usr/bin/env node
/**
 * ai-train-shortterm.js
 * Ask an LLM for a logistic formula from the compact feature summary.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = require('node-fetch');
const minimist = require('minimist');
const { z } = require('zod');

/* ---------- CLI ---------- */
const rawArgs = minimist(process.argv.slice(2), {
  string: ['summary', 'model', 'out', 'sigmoid'],
  default: { model: 'gpt-4o-mini', out: 'model/ai_formula.json', budget: 0.05 }
});

function normalizeSigmoid(r) {
  if (typeof r.sigmoid === 'string') {
    try { r.sigmoid = JSON.parse(r.sigmoid); } catch { r.sigmoid = {}; }
  }
  if (r['sigmoid.tempMin'] != null) {
    r.sigmoid = r.sigmoid && typeof r.sigmoid === 'object' ? r.sigmoid : {};
    const v = Number(r['sigmoid.tempMin']);
    if (!Number.isNaN(v)) r.sigmoid.tempMin = v;
  }
  if (!r.sigmoid || typeof r.sigmoid !== 'object') r.sigmoid = {};
  return r;
}
const args = normalizeSigmoid(rawArgs);

const ArgSchema = z.object({
  summary: z.string(),
  model: z.string().default('gpt-4o-mini'),
  out: z.string().default('model/ai_formula.json'),
  budget: z.coerce.number().default(0.05),
  sigmoid: z.object({ tempMin: z.coerce.number().optional() }).default({})
});
const cfg = ArgSchema.parse(args);

const summaryPath = cfg.summary;
const outPath     = cfg.out;
const model       = cfg.model;
const budget      = cfg.budget;

/* ---------- API key ---------- */
const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('Missing OPENAI_API_KEY. Put it in .env or set $env:OPENAI_API_KEY before running.');
  process.exit(1);
}

/* ---------- Load summary ---------- */
if (!fs.existsSync(summaryPath)) {
  console.error(`Input summary file not found: ${summaryPath}`);
  process.exit(2);
}
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

/* ---------- Schemas & normalizer for LLM reply ---------- */
const FeatureWeightsSchema = z.record(z.string(), z.number());

const FlexibleReply = z.object({
  // Preferred shape:
  sigmoid: z.object({
    intercept: z.number().optional(),
    weights: FeatureWeightsSchema.optional()
  }).optional(),

  // Alternate shape the model might return at root:
  intercept: z.number().optional(),
  weights: FeatureWeightsSchema.optional(),

  // Optional metadata/rules
  version: z.string().optional(),
  rules: z.object({
    minConf: z.number().min(0).max(1).optional(),
    atrMax: z.number().min(0).optional(),
    minTemp: z.number().min(0).optional(),
    longShort: z.boolean().optional(),
    notes: z.array(z.string()).optional()
  }).optional()
});

function coerceToCanonical(raw) {
  const r = FlexibleReply.parse(raw);

  // Choose intercept/weights from either place
  const intercept = r.sigmoid?.intercept ?? r.intercept;
  const weights   = r.sigmoid?.weights   ?? r.weights;

  if (!Number.isFinite(intercept) || !weights || typeof weights !== 'object') {
    throw new Error('LLM reply missing intercept/weights. See tmp/ai_raw.json for details.');
  }

  return {
    version: r.version || 'shortterm_ai_v1',
    sigmoid: { intercept, weights },
    rules: {
      minConf: r.rules?.minConf ?? 0.45,
      atrMax : r.rules?.atrMax  ?? 0.045,
      minTemp: r.rules?.minTemp ?? 1.0,
      longShort: r.rules?.longShort ?? true,
      notes: r.rules?.notes
    }
  };
}

/* ---------- Prompt ---------- */
const FEATURE_KEYS = summary.features.map(f => f.key);

const systemPrompt = `
You are a quantitative research assistant. You receive aggregate, privacy-safe feature stats for a next-day direction task on US equities.
Return a *JSON object only*. Prefer this shape:
{
  "version": "shortterm_ai_v1",
  "sigmoid": { "intercept": <number>, "weights": { "<feature>": <number>, ... } },
  "rules": { "minConf": 0.45, "atrMax": 0.045, "minTemp": 1.0, "longShort": true }
}
Weights should be modest (|w_j| <= 2 when reasonable) and respect monotonicity suggested by deciles.
NO prose or markdown, JSON only.
`;

const userPrompt = {
  task: "Propose weights for a short-term (next-day) direction logistic model.",
  feature_order: FEATURE_KEYS,
  base: {
    totalObs: summary.meta.totalObs,
    baseUpRate: summary.meta.baseUpRate,
    meanNextDayLogRet: summary.meta.meanNextDayLogRet
  },
  per_feature: summary.features.map(f => ({
    key: f.key, n: f.n, mean: f.mean, std: f.std,
    corrUp: f.corrUp, corrRet: f.corrRet, deciles: f.deciles
  }))
};

/* ---------- OpenAI call ---------- */
async function callOpenAI() {
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: 'system', content: systemPrompt.trim() },
      { role: 'user', content: JSON.stringify(userPrompt) }
    ]
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error('Model response was not valid JSON.'); }

  return parsed;
}

/* ---------- Main ---------- */
(async () => {
  try {
    console.log(`Using model=${model}, budget=${budget}, summary=${summaryPath}`);

    const raw = await callOpenAI();

    // Save raw for debugging regardless
    fs.mkdirSync('tmp', { recursive: true });
    fs.writeFileSync('tmp/ai_raw.json', JSON.stringify(raw, null, 2));

    // Normalize flexible shapes -> canonical
    const modelObj = coerceToCanonical(raw);

    // ensure weights exactly cover feature set
    const weights = {};
    for (const k of FEATURE_KEYS) {
      const w = modelObj.sigmoid.weights[k];
      weights[k] = Number.isFinite(w) ? w : 0;
    }
    modelObj.sigmoid.weights = weights;

    const out = {
      generatedAt: new Date().toISOString(),
      model,
      version: modelObj.version,
      feature_order: FEATURE_KEYS,
      sigmoid: {
        intercept: modelObj.sigmoid.intercept,
        weights: modelObj.sigmoid.weights
      },
      rules: modelObj.rules
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`Wrote AI formula → ${outPath}`);
  } catch (err) {
    // Persist whatever we got for inspection
    try { fs.mkdirSync('tmp', { recursive: true }); fs.writeFileSync('tmp/ai_error.txt', String(err.stack || err)); } catch {}
    console.error('Failure:', err.message);
    console.error('Raw reply (if any) saved to tmp/ai_raw.json');
    process.exit(4);
  }
})();

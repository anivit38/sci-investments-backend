/*****************************************************************
 * backend/data/trainGRU.js   Phase‑3 monolithic CSV version
 *
 *  • node trainGRU.js AAPL MSFT   ← train a few symbols
 *  • node trainGRU.js            ← train every symbol in the CSV
 *
 *  Exports:
 *      predictNextDay(symbol, windowData)
 *****************************************************************/
const fs   = require('fs');
const path = require('path');
const tf   = require('@tensorflow/tfjs-node');
const csv  = require('csv-parser');

const LOOKBACK     = 30;    // rolling‑window length
const TEST_SPLIT   = 0.20;  // 20 % validation
const MODEL_ROOT   = path.join(__dirname, '..', 'model', 'forecast_model_phase3');
const ENRICHED_CSV = path.join(__dirname, 'historicalData_enriched_full.csv');

// ───────────────────────────────────────────────────────────────
// 1)  Read the big CSV into memory
// ───────────────────────────────────────────────────────────────
async function loadAllData () {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(ENRICHED_CSV)
      .pipe(csv())
      .on('data', r => rows.push(r))
      .on('end', ()  => resolve(rows))
      .on('error', reject);
  });
}

// ───────────────────────────────────────────────────────────────
// 2)  Group rows by symbol & sort by date
// ───────────────────────────────────────────────────────────────
function groupBySymbol (allRows) {
  const by = {};
  allRows.forEach(r => {
    by[r.symbol] ||= [];
    by[r.symbol].push(r);
  });
  Object.keys(by).forEach(sym =>
    by[sym].sort((a, b) => new Date(a.date) - new Date(b.date))
  );
  return by;
}

// ───────────────────────────────────────────────────────────────
// 3)  Convert a symbol’s rows into tensors
// ───────────────────────────────────────────────────────────────
function prepareSymbolData (rows) {
  if (!rows || rows.length <= LOOKBACK)
    throw new Error('Not enough rows for training');

  const featureKeys = Object.keys(rows[0]).filter(k => k !== 'symbol' && k !== 'date');

  const raw = rows.map(r => featureKeys.map(k => +r[k] || 0));

  // Min‑max scaler (per feature, per symbol)
  const scaler = {};
  featureKeys.forEach((k, i) => {
    const col = raw.map(r => r[i]);
    scaler[k] = { min: Math.min(...col), max: Math.max(...col) };
  });

  const scaled = raw.map(r =>
    r.map((v, i) => {
      const { min, max } = scaler[featureKeys[i]];
      return max === min ? 0 : (v - min) / (max - min);
    })
  );

  const X = [], Y = [];
  const closeIdx = featureKeys.indexOf('close');
  for (let i = LOOKBACK; i < scaled.length; i++) {
    X.push(scaled.slice(i - LOOKBACK, i));
    Y.push([raw[i][closeIdx]]);          // predict *un‑scaled* closing price
  }

  if (!X.length) throw new Error('No training samples generated');

  return {
    featureKeys,
    scaler,
    xs: tf.tensor3d(X),
    ys: tf.tensor2d(Y)
  };
}

// ───────────────────────────────────────────────────────────────
// 4)  Train GRU for one symbol & save it
// ───────────────────────────────────────────────────────────────
async function trainSymbol (sym, rows) {
  console.log(`\n📘  Preparing data for ${sym}`);
  let featureKeys, scaler, xs, ys;
  ({ featureKeys, scaler, xs, ys } = prepareSymbolData(rows));

  const total    = xs.shape[0];
  const valLen   = Math.floor(total * TEST_SPLIT);
  const trainLen = total - valLen;

  const xTrain = xs.slice([0, 0, 0], [trainLen, LOOKBACK, featureKeys.length]);
  const yTrain = ys.slice([0, 0],    [trainLen, 1]);
  const xVal   = xs.slice([trainLen, 0, 0], [valLen, LOOKBACK, featureKeys.length]);
  const yVal   = ys.slice([trainLen, 0],    [valLen, 1]);

  const model = tf.sequential();
  model.add(tf.layers.gru({ units: 64, returnSequences: true,
                            inputShape: [LOOKBACK, featureKeys.length] }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.gru({ units: 32 }));
  model.add(tf.layers.dropout({ rate: 0.2 }));
  model.add(tf.layers.dense({ units: 1 }));
  model.compile({ optimizer: tf.train.adam(), loss: 'meanSquaredError', metrics: ['mse'] });

  console.log(`🏋️‍♂️  Training ${sym}: ${trainLen} train → ${valLen} val`);
  await model.fit(xTrain, yTrain, {
    epochs: 7,
    batchSize: 32,
    validationData: [xVal, yVal],
    callbacks: tf.callbacks.earlyStopping({
      monitor: 'val_loss',
      patience: 2,
      restoreBestWeight: true
    })
  });

  // save artefacts
  const outDir = path.join(MODEL_ROOT, sym);
  fs.mkdirSync(outDir, { recursive: true });
  await model.save(`file://${outDir}`);
  fs.writeFileSync(path.join(outDir, 'scaler.json'),
                   JSON.stringify({ scaler, featureKeys }, null, 2));

  tf.dispose([xs, ys, xTrain, yTrain, xVal, yVal, model]);
  console.log(`✅  ${sym} saved → ${outDir}`);
}

// ───────────────────────────────────────────────────────────────
// 5)  CLI training loop (only when run directly)
// ───────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      console.log('⏳  Loading CSV …');
      const allRows = await loadAllData();
      const bySym   = groupBySymbol(allRows);

      const cliSyms = process.argv.slice(2);
      const symbols = cliSyms.length ? cliSyms.filter(s => bySym[s]) : Object.keys(bySym);

      console.log('⚙️   Symbols to train ⇒', symbols.join(', '));
      for (const sym of symbols) await trainSymbol(sym, bySym[sym]);

      console.log('\n🎉  All requested symbols processed.');
    } catch (e) {
      console.error('💥  Fatal:', e.message);
      console.error(e.stack);
    }
  })();
}

// ───────────────────────────────────────────────────────────────
// 6)  Inference helper  (used by server.js)
// ───────────────────────────────────────────────────────────────
const _models  = {};
const _scalers = {};

module.exports.predictNextDay = async function predictNextDay (symbol, windowData) {
  if (!_models[symbol]) {
    _models[symbol] = await tf.loadLayersModel(`file://${path.join(MODEL_ROOT, symbol, 'model.json')}`);
    const sc        = require(path.join(MODEL_ROOT, symbol, 'scaler.json'));
    _scalers[symbol] = sc.scaler;
  }
  const model  = _models[symbol];
  const scaler = _scalers[symbol];

  const scaledWindow = windowData.map(row =>
    row.map((v, i) => {
      const key = Object.keys(scaler)[i];
      const { min, max } = scaler[key];
      return max === min ? 0 : (v - min) / (max - min);
    })
  );

  const input = tf.tensor3d([scaledWindow]);          // [1, 30, D]
  const out   = model.predict(input);
  const pred  = out.dataSync()[0];
  input.dispose(); out.dispose();

  const { min, max } = scaler.close;                  // rescale prediction
  return pred * (max - min) + min;
};

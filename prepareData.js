/*****************************************************************
 * prepareData.js  – Phase-3, bucket‐aware, with NASDAQ default
 *****************************************************************/
const fs   = require('fs');
const path = require('path');
const tf   = require('@tensorflow/tfjs-node');

const FEATURES = [
  // prices
  'open','high','low','close','adjclose','volume','dailyReturn',
  // phase-2 tech
  'SMA20','RSI14','MACD','BB_upper','BB_lower','ATR14',
  // phase-3 tech
  'Volatility5','VWAPratio','OBV','NewsSentMA3d',
  // fundamentals
  'peRatio','earningsGrowth','debtToEquity','revenue','netIncome'
];  // total 23 features

const LOOKBACK   = 30;
const DATA_DIR   = path.join(__dirname, 'data');
const SCALER_DIR = path.join(__dirname, 'models', 'scalers');

// exchange → bucket filename map
const BKT = {
  NASDAQ: 'NASDAQ.csv',
  NYSE:   'NYSE.csv',
  TSX:    'TSX.csv'
};

const SYMLIST = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'symbols.json'), 'utf8')
);

/**
 * Read the last LOOKBACK rows for `sym` from its exchange bucket.
 * If `sym` has no `ex` in symbols.json, defaults to NASDAQ.
 */
function fetchRows(sym) {
  // look up exchange, default to NASDAQ if missing
  const entry = SYMLIST.find(x => x.symbol === sym) || {};
  const ex    = entry.ex || 'NASDAQ';

  const bucketFile = BKT[ex];
  if (!bucketFile) {
    throw new Error(`No bucket defined for exchange '${ex}' (symbol ${sym})`);
  }

  const fp = path.join(DATA_DIR, bucketFile);
  if (!fs.existsSync(fp)) {
    throw new Error(`${bucketFile} not found — run updateCSV first`);
  }

  const out = [];
  const rl  = require('readline').createInterface({
    input: fs.createReadStream(fp),
    crlfDelay: Infinity
  });

  return new Promise(resolve => {
    rl.on('line', line => {
      if (!line.startsWith(sym + ',')) return;
      const fields = line.split(',');
      out.push(fields);
      if (out.length > LOOKBACK) out.shift();
    });
    rl.on('close', () => resolve(out));
  });
}

function buildScalers(rows) {
  const scalers = {};
  FEATURES.forEach((f, i) => {
    const vals = rows.map(r => +r[i + 2]); // skip symbol, date
    scalers[f] = {
      min: Math.min(...vals),
      max: Math.max(...vals)
    };
  });
  return scalers;
}

function scale(rows, scalers) {
  return rows.map(row =>
    FEATURES.map((f, i) => {
      const v = +row[i + 2];
      const { min, max } = scalers[f];
      return max === min ? 0 : (v - min) / (max - min);
    })
  );
}

function tensorise(arr) {
  const xs = [];
  const ys = [];
  for (let i = LOOKBACK; i < arr.length; i++) {
    xs.push(arr.slice(i - LOOKBACK, i));
    // next-day close is at index 2 + FEATURES.indexOf('close')
    ys.push([ +arr[i][2 + FEATURES.indexOf('close')] ]);
  }
  return {
    xs: tf.tensor3d(xs),
    ys: tf.tensor2d(ys)
  };
}

async function prepare(sym) {
  const raw = await fetchRows(sym);
  if (raw.length < LOOKBACK) {
    throw new Error(`${sym}: only ${raw.length} rows (need ${LOOKBACK})`);
  }

  const scalers = buildScalers(raw);
  const scaled  = scale(raw, scalers);
  const { xs, ys } = tensorise(scaled);

  if (!fs.existsSync(SCALER_DIR)) {
    fs.mkdirSync(SCALER_DIR, { recursive: true });
  }
  fs.writeFileSync(
    path.join(SCALER_DIR, `${sym}_scaler.json`),
    JSON.stringify({ scalers, FEATURES }, null, 2),
    'utf8'
  );

  return { xs, ys, scalerPath: path.join(SCALER_DIR, `${sym}_scaler.json`) };
}

module.exports = {
  prepare,
  FEATURES,
  LOOKBACK
};

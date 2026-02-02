// backend/ml/stacker.js
const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs-node');

const DEFAULT_MODEL_PATH = path.join(__dirname, '..', 'model', 'stacker.json');

function standardize(X) {
  const Xten = tf.tensor2d(X);
  const mean = Xten.mean(0);
  const std = tf.moments(Xten, 0).variance.sqrt().add(1e-8);
  const Xn = Xten.sub(mean).div(std);
  return { Xn, mean: mean.arraySync(), std: std.arraySync() };
}

function applyStandardize(X, mean, std) {
  const Xten = tf.tensor2d(X);
  const Xn = Xten.sub(tf.tensor1d(mean)).div(tf.tensor1d(std));
  return Xn;
}

// closed-form ridge: (X^T X + λI)^-1 X^T y
function ridgeFit(Xn, y, lambda = 1e-2) {
  return tf.tidy(() => {
    const X = tf.tensor2d(Xn);
    const Y = tf.tensor1d(y);
    const [n, d] = X.shape;
    const I = tf.eye(d);
    const W = tf.linalg
      .inv(X.transpose().matMul(X).add(I.mul(lambda)))
      .matMul(X.transpose())
      .matMul(Y.reshape([n, 1]));
    return W.reshape([d]).arraySync();
  });
}

// logistic via a few epochs of gradient descent (small d)
async function logisticFit(Xn, y, lr = 0.1, epochs = 300) {
  const X = tf.tensor2d(Xn);
  const Y = tf.tensor1d(y);
  const [n, d] = X.shape;
  let W = tf.zeros([d]);
  for (let i = 0; i < epochs; i++) {
    const { grad } = tf.variableGrads(() => {
      const z = tf.sigmoid(X.matMul(W.reshape([d, 1])).reshape([n]));
      // binary cross-entropy
      const loss = tf.losses.logLoss(Y, z).add(W.square().sum().mul(1e-4)); // tiny L2
      return loss;
    });
    W = tf.tidy(() => W.sub(grad[W.id].mul(lr)));
    tf.dispose(grad);
  }
  const wArr = W.arraySync();
  tf.dispose([X, Y, W]);
  return wArr;
}

function predictLogistic(Xn, w) {
  const X = tf.tensor2d(Xn);
  const yhat = tf.sigmoid(X.matMul(tf.tensor2d(w, [w.length, 1]))).reshape([X.shape[0]]);
  const out = yhat.arraySync();
  tf.dispose([X, yhat]);
  return out;
}
function predictLinear(Xn, w) {
  const X = tf.tensor2d(Xn);
  const yhat = X.matMul(tf.tensor2d(w, [w.length, 1])).reshape([X.shape[0]]);
  const out = yhat.arraySync();
  tf.dispose([X, yhat]);
  return out;
}

async function fitStacker({ X, yDir, yMag, lambda = 1e-2 }) {
  const { Xn, mean, std } = standardize(X);
  const XnArr = Xn.arraySync();
  const wDir = await logisticFit(XnArr, yDir);
  const wMag = ridgeFit(XnArr, yMag, lambda);
  return { mean, std, wDir, wMag, lambda, version: 1 };
}

function predictStacker(model, X) {
  const Xn = applyStandardize(X, model.mean, model.std).arraySync();
  const pUp = predictLogistic(Xn, model.wDir);
  const mag = predictLinear(Xn, model.wMag).map(v => Math.max(0.001, Math.min(0.10, Math.abs(v))));
  return { pUp, mag };
}

function saveStacker(model, file = DEFAULT_MODEL_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(model, null, 2));
  return file;
}
function loadStacker(file = DEFAULT_MODEL_PATH) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  fitStacker,
  predictStacker,
  saveStacker,
  loadStacker,
  DEFAULT_MODEL_PATH,
};

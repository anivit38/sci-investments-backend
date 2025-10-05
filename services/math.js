// backend/services/math.js
function median(arr) {
  const a = [...arr].filter(x => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function mad(arr, med = median(arr)) {
  const dev = arr.map(x => Math.abs(x - med)).filter(Number.isFinite);
  return median(dev) || NaN;
}
function zScoreMAD(Xt, past) {
  const med = median(past);
  const m = mad(past, med);
  return (Xt - med) / (m || Number.EPSILON);
}
function sma(vals, n) {
  if (vals.length < n) return Array(vals.length).fill(NaN);
  const out = Array(vals.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function ema(vals, n) {
  if (!vals.length) return [];
  const k = 2 / (n + 1);
  const out = Array(vals.length).fill(NaN);
  let prev = vals[0];
  out[0] = prev;
  for (let i = 1; i < vals.length; i++) {
    prev = vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
module.exports = { median, mad, zScoreMAD, sma, ema };

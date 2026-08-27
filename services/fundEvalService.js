// backend/services/fundEvalService.js
//
// Fund/ETF evaluation — a DIFFERENT rubric than the stock evaluation in
// server.js's /api/check-stock, based on the fund-diligence checklist
// (return performance vs benchmark, Sharpe, information ratio, downside
// capture, drawdown recovery — the metrics genuinely computable from a price
// history). Several checklist items (active share, geographic concentration,
// fees, manager co-investment, cash drag, unrealized cap-gains exposure,
// turnover/TCA) need fund holdings or filings data this app doesn't have a
// source for yet — those are returned as clearly-labelled "Unavailable"
// findings rather than guessed at, same convention server.js already uses
// for missing stock data.
//
// Price history comes from the existing quant layer's getExtendedHistory()
// (Yahoo-backed, 15-day cache) rather than FMP, because FMP's ETF historical
// price endpoint is restricted on the current subscription plan (confirmed:
// works for stocks, 402s for ETFs) while ETFs behave like any other ticker
// through Yahoo's chart endpoint.

const { getExtendedHistory } = require('../quant/historicalFetch');

const RF = 0.0525; // same risk-free proxy used by the stock DCF/WACC section

function pickBenchmark(profile) {
  const country = String(profile?.country || '').toUpperCase();
  const sector = String(profile?.sector || '').toLowerCase();
  const name = String(profile?.companyName || '').toLowerCase();
  if (sector.includes('bond') || name.includes('bond') || name.includes('aggregate')) {
    return { symbol: 'AGG', label: 'Bloomberg US Aggregate Bond proxy (AGG)' };
  }
  if (country && country !== 'US') {
    return { symbol: 'EFA', label: 'MSCI EAFE proxy (EFA)' };
  }
  return { symbol: 'SPY', label: 'S&P 500 proxy (SPY)' };
}

function windowReturn(rows, years) {
  if (!rows || rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const cutoff = new Date(last.date).getTime() - years * 365.25 * 86400000;
  const start = rows.find(r => new Date(r.date).getTime() >= cutoff);
  if (!start || start === last) return null;
  if (new Date(rows[0].date).getTime() > cutoff + 5 * 86400000) return null; // history doesn't reach back that far
  return last.close / start.close - 1;
}

function annualizedStats(logRet) {
  if (!logRet || logRet.length < 30) return null;
  const rs = logRet.map(x => x.r);
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1);
  return { annReturn: mean * 252, annVol: Math.sqrt(variance) * Math.sqrt(252) };
}

function dateKey(d) { return String(d instanceof Date ? d.toISOString() : d).slice(0, 10); }

function alignedDiffs(fundLogRet, benchLogRet) {
  const benchMap = new Map(benchLogRet.map(x => [dateKey(x.date), x.r]));
  const pairs = [];
  for (const f of fundLogRet) {
    const b = benchMap.get(dateKey(f.date));
    if (b != null) pairs.push({ f: f.r, b });
  }
  return pairs;
}

function informationRatio(fundLogRet, benchLogRet) {
  const pairs = alignedDiffs(fundLogRet, benchLogRet);
  if (pairs.length < 60) return null;
  const diffs = pairs.map(p => p.f - p.b);
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1);
  const te = Math.sqrt(variance) * Math.sqrt(252);
  if (te === 0) return null;
  return (mean * 252) / te;
}

function downsideCapture(fundLogRet, benchLogRet) {
  const pairs = alignedDiffs(fundLogRet, benchLogRet).filter(p => p.b < 0);
  if (pairs.length < 20) return null;
  const fundDown = pairs.reduce((a, p) => a + p.f, 0);
  const benchDown = pairs.reduce((a, p) => a + p.b, 0);
  if (benchDown === 0) return null;
  return (fundDown / benchDown) * 100;
}

function maxDrawdownPeriod(rows) {
  if (!rows || rows.length < 30) return null;
  let peak = rows[0].close, peakIdx = 0;
  let worst = { dd: 0, peakIdx: 0, troughIdx: 0 };
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].close > peak) { peak = rows[i].close; peakIdx = i; }
    const dd = rows[i].close / peak - 1;
    if (dd < worst.dd) worst = { dd, peakIdx, troughIdx: i };
  }
  const peakVal = rows[worst.peakIdx].close;
  let recoverIdx = null;
  for (let i = worst.troughIdx + 1; i < rows.length; i++) {
    if (rows[i].close >= peakVal) { recoverIdx = i; break; }
  }
  const daysToRecover = recoverIdx != null
    ? Math.round((new Date(rows[recoverIdx].date) - new Date(rows[worst.peakIdx].date)) / 86400000)
    : null;
  return { maxDrawdownPct: worst.dd * 100, daysToRecover, stillDown: recoverIdx == null };
}

const UNAVAILABLE_ITEMS = [
  ['Active share', 'Requires fund holdings-level data — the FMP ETF-holdings endpoint is restricted on the current subscription plan.'],
  ['Geographic concentration', 'Requires fund holdings-level country breakdown, not available from the current data source.'],
  ['Fees (MER / TER)', 'Expense ratio and trading-expense data are not available from the current data source.'],
  ['Manager co-investment', 'Not disclosed via any data source currently wired up.'],
  ['Embedded cash drag', 'Requires fund holdings-level cash weighting, not available from the current data source.'],
  ['Unrealized capital gains exposure', 'Requires fund tax-disclosure data (PCGE), not available from the current data source.'],
  ['Turnover / trading costs (TCA)', 'Requires the fund’s MRFP/SAI filing data, not available from the current data source.'],
];

/**
 * @returns {Promise<Array<{section, stat, value, meaning, result}>>}
 */
async function evaluateFund(symbol, profile) {
  const findings = [];
  const record = (stat, value, meaning, result = 'neutral') =>
    findings.push({ section: 'Fund Evaluation', stat, value, meaning, result });

  const bench = pickBenchmark(profile);
  const [fundHist, benchHist] = await Promise.all([
    getExtendedHistory(symbol),
    getExtendedHistory(bench.symbol),
  ]);

  if (!fundHist.rows.length) {
    record('Return performance', 'Unavailable', 'Historical price data is not available for this fund from the current data source.');
    UNAVAILABLE_ITEMS.forEach(([stat, meaning]) => record(stat, 'Unavailable', meaning));
    return findings;
  }

  [[1, '1-year'], [3, '3-year'], [5, '5-year']].forEach(([yrs, label]) => {
    const fundRet = windowReturn(fundHist.rows, yrs);
    if (fundRet == null) {
      record(`${label} return`, 'Unavailable', `Not enough price history yet (fund likely younger than ${yrs} years).`);
      return;
    }
    const benchRet = windowReturn(benchHist.rows, yrs);
    const diffPp = benchRet != null ? (fundRet - benchRet) * 100 : null;
    record(
      `${label} return`,
      `${(fundRet * 100).toFixed(1)}%`,
      benchRet != null
        ? `Vs ${bench.label}: ${(benchRet * 100).toFixed(1)}%. ${diffPp > 0 ? 'Outperformed' : 'Underperformed'} by ${Math.abs(diffPp).toFixed(1)}pp.`
        : `${bench.label} comparison unavailable for this window.`,
      diffPp == null ? 'neutral' : diffPp > 0 ? 'good' : 'bad'
    );
  });

  const stats = annualizedStats(fundHist.logRet);
  if (stats) {
    const sharpe = (stats.annReturn - RF) / stats.annVol;
    record('Sharpe ratio', sharpe.toFixed(2),
      'Annualized excess return over volatility, using full available price history. Above 0.7–1.0 is good; 1–3 is strong; above 3 may reflect an unusually short or lucky window rather than durable skill.',
      sharpe > 1 ? 'good' : sharpe < 0.5 ? 'bad' : 'neutral');
  } else {
    record('Sharpe ratio', 'Unavailable', 'Not enough price history to compute volatility.');
  }

  const ir = informationRatio(fundHist.logRet, benchHist.logRet);
  if (ir != null) {
    record('Information ratio', ir.toFixed(2),
      `Excess return over ${bench.label} per unit of tracking error. Above 0.5 suggests real skill rather than benchmark drift.`,
      ir > 0.5 ? 'good' : 'neutral');
  } else {
    record('Information ratio', 'Unavailable', 'Not enough overlapping history with the benchmark proxy.');
  }

  const dc = downsideCapture(fundHist.logRet, benchHist.logRet);
  if (dc != null) {
    record('Downside capture ratio', `${dc.toFixed(0)}%`,
      `On days ${bench.label} fell, this fund captured ${dc.toFixed(0)}% of that decline on average. Lower is better — it means the fund cushions drawdowns rather than amplifying them.`,
      dc < 100 ? 'good' : 'bad');
  } else {
    record('Downside capture ratio', 'Unavailable', 'Not enough overlapping down-day history with the benchmark proxy.');
  }

  const dd = maxDrawdownPeriod(fundHist.rows);
  if (dd) {
    const months = dd.daysToRecover != null ? dd.daysToRecover / 30.44 : null;
    record(
      'Max drawdown & recovery',
      dd.stillDown ? `${dd.maxDrawdownPct.toFixed(1)}% (not yet recovered)` : `${dd.maxDrawdownPct.toFixed(1)}%, ~${Math.round(months)}mo to recover`,
      `Largest peak-to-trough decline in available price history${dd.stillDown ? ', and the fund has not yet recovered to its prior peak' : `, recovering in roughly ${Math.round(months)} months`}. 12–18 months to recover is typical for a healthy fund — compare against peer funds in the same category rather than judging in isolation.`,
      dd.stillDown ? 'bad' : (months != null && months <= 18 ? 'good' : 'neutral')
    );
  } else {
    record('Max drawdown & recovery', 'Unavailable', 'Not enough price history to identify a drawdown cycle.');
  }

  UNAVAILABLE_ITEMS.forEach(([stat, meaning]) => record(stat, 'Unavailable', meaning));

  return findings;
}

module.exports = { evaluateFund, pickBenchmark };

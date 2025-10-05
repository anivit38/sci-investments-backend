// scripts/explain-utils.js  (ADVANCED blame & reasons)

const fs = require('fs');
const path = require('path');

const csvCell = (s) => {
  if (s == null) return '';
  const str = String(s);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

function normKey(k){ return String(k||'').toLowerCase().replace(/\s+/g,'').replace(/[%()]/g,'').replace(/[^a-z0-9_]/g,''); }
function canonicalName(k){
  const nk = normKey(k);
  const map = {
    'ztrend':'zTrend','zst':'zTrend','zspread':'zTrend','z_s':'zTrend','zema10_20spread':'zTrend',
    'clv':'CLV','clvnorm':'CLV',
    'k':'stochK','stochk':'stochK','percentk':'stochK',
    'gapnorm':'gapNorm','gapz':'gapNorm',
    'zdlrvol':'zDeltaLogRVOL','zdlrvolabs':'zDeltaLogRVOL','zdelogrvol':'zDeltaLogRVOL','zrvoldelta':'zDeltaLogRVOL','z_dlogrv':'zDeltaLogRVOL',
    'deltatrpct':'deltaATRpct','deltatrpercent':'deltaATRpct','datrpercent':'deltaATRpct',
    'atrpct':'atrPct','atrpercent':'atrPct',
    'rsi':'RSI','macd':'MACD','vwapratio':'VWAPratio','obv':'OBV','pctb':'pctB','k%':'stochK',
    'bbw':'BBW','z_dbbw':'z_dBBW','fill':'fill'
  };
  return map[nk] || k;
}

function fmt(x){ if(x==null||Number.isNaN(x)) return '';
  const v=Number(x);
  if(Math.abs(v)>=1000) return v.toFixed(0);
  if(Math.abs(v)>=100) return v.toFixed(1);
  if(Math.abs(v)>=10) return v.toFixed(2);
  if(Math.abs(v)>=1) return v.toFixed(3);
  return v.toFixed(4);
}

/** Signed directional score: +1 favors UP, -1 favors DOWN */
function dirScore(name, raw){
  const n = canonicalName(name);
  if (raw==null || Number.isNaN(raw)) return 0;
  switch(n){
    case 'zTrend': { const z=Math.max(-2,Math.min(2,raw)); return z/2; }
    case 'CLV':    { if(raw>=0.3) return Math.min(1,(raw-0.3)/0.7); if(raw<=-0.3) return Math.max(-1,(raw+0.3)/0.7); return 0; }
    case 'stochK': { if(raw>=60) return Math.min(1,(raw-60)/40); if(raw<=40) return Math.max(-1,(raw-40)/40); return 0; }
    case 'gapNorm':{ if(raw>=0.5) return Math.min(1,(raw-0.5)/1.0); if(raw<=-0.5) return Math.max(-1,(raw+0.5)/1.0); return 0; }
    case 'zDeltaLogRVOL': { const mag=Math.min(2,Math.max(-2,raw))/2; return Math.sign(mag)*0.25; }
    case 'deltaATRpct': { return Math.tanh(raw*5)*0.1; }
    case 'atrPct': return 0;
    case 'RSI': { if(raw>=60) return Math.min(1,(raw-60)/40); if(raw<=40) return Math.max(-1,(raw-40)/40); return 0; }
    case 'MACD': { const z=Math.max(-2,Math.min(2,raw)); return z/2; }
    case 'VWAPratio': { return Math.max(-1,Math.min(1,raw-1)); }
    case 'OBV': { return Math.sign(raw)*0.25; }
    default: { const z=Math.max(-2,Math.min(2,Number(raw))); return z/4; }
  }
}

/** Natural-language reason for a metric’s bias (plain English) */
function reasonForMetric(name, raw){
  const n = canonicalName(name);
  const v = Number(raw);
  if (!Number.isFinite(v)) return '';
  switch(n){
    case 'zTrend': return `zTrend=${fmt(v)}σ → EMA10-20 spread ${v>=0?'up-bias':'down-bias'}`;
    case 'CLV':    return v>=0.3 ? `CLV=${fmt(v)} ≥ 0.3 → close near high (accumulation)` :
                     v<=-0.3 ? `CLV=${fmt(v)} ≤ -0.3 → close near low (distribution)` :
                     `CLV=${fmt(v)} (neutral)`;
    case 'stochK': return v>=80 ? `stochK=${fmt(v)} (>80 overbought) → up-bias w/ reversal risk` :
                     v<=20 ? `stochK=${fmt(v)} (<20 oversold) → down-bias w/ rebound risk` :
                     v>=60 ? `stochK=${fmt(v)} (≥60 up-bias)` :
                     v<=40 ? `stochK=${fmt(v)} (≤40 down-bias)` :
                     `stochK=${fmt(v)} (neutral)`;
    case 'gapNorm':return v>=0.5 ? `gapNorm=${fmt(v)} ≥ 0.5 → gap-up continuation bias` :
                     v<=-0.5 ? `gapNorm=${fmt(v)} ≤ -0.5 → gap-down continuation bias` :
                     `gapNorm=${fmt(v)} (neutral)`;
    case 'zDeltaLogRVOL': return `|zΔRVOL|=${fmt(Math.abs(v))} → regime-shift risk`;
    case 'deltaATRpct': return v>=0 ? `ΔATR%=${fmt(v)} rising vol → continuation amplification`
                                    : `ΔATR%=${fmt(v)} falling vol → mean-revert bias`;
    case 'RSI':    return v>=60 ? `RSI=${fmt(v)} (bullish)` : v<=40 ? `RSI=${fmt(v)} (bearish)` : `RSI=${fmt(v)} (neutral)`;
    case 'MACD':   return v>=0 ? `MACD/ATR=${fmt(v)} (bullish momentum)` : `MACD/ATR=${fmt(v)} (bearish momentum)`;
    case 'pctB':   return v>=0.8 ? `pctB=${fmt(v)} (upper band) → overbought/continuation risk`
                                 : v<=0.2 ? `pctB=${fmt(v)} (lower band) → oversold/mean-revert risk`
                                          : `pctB=${fmt(v)} (mid)`;
    case 'VWAPratio': return v>=1 ? `VWAPratio=${fmt(v)} ≥1 (above VWAP) → up-bias` : `VWAPratio=${fmt(v)} <1 (below VWAP) → down-bias`;
    case 'OBV':    return v>=0 ? `OBV sign + (buy-volume bias)` : `OBV sign − (sell-volume bias)`;
    default:       return `${n}=${fmt(v)}`;
  }
}

/** Per-metric signed contribution */
function computeContributions(features, modelWeights={}){
  const contribs=[];
  for(const [k,v] of Object.entries(features||{})){
    const canon=canonicalName(k);
    const w=Number(modelWeights[canon] ?? modelWeights[k] ?? 1.0);
    const s=dirScore(canon, Number(v));
    const c=w*s; // signed toward UP(+)/DOWN(−)
    contribs.push({name:canon, raw:Number(v), score:s, weight:w, contrib:c});
  }
  contribs.sort((a,b)=>Math.abs(b.contrib)-Math.abs(a.contrib));
  return contribs;
}

/** Build per-trade WHY + HOW row for wrong calls */
function buildWrongRow({ symbol,date,pUp,pred,actual,ret1d,features,modelWeights,gates,params }){
  const contribs = computeContributions(features, modelWeights);
  const sumUp   = contribs.filter(c=>c.contrib>0).reduce((s,c)=>s+c.contrib,0);
  const sumDown = contribs.filter(c=>c.contrib<0).reduce((s,c)=>s+c.contrib,0); // negative

  const wrongSide = pred;               // +1 if called UP, −1 if called DOWN
  const rightSide = actual;             // actual outcome (+1/−1)
  const net = sumUp + sumDown;          // signed margin (up minus |down|)
  const wrongSidePower = wrongSide===1 ? sumUp : Math.abs(sumDown);
  const rightSidePower = wrongSide===1 ? Math.abs(sumDown) : sumUp;
  const margin = wrongSidePower - rightSidePower;

  // classify “how” it’s wrong
  const highConf = Number.isFinite(pUp) ? (Math.abs(pUp-0.5) >= 0.20) : false; // ≥60/40
  const flags=[];
  const atrPct = Number(features?.atrPct);
  if(Number.isFinite(atrPct) && Number.isFinite(params?.atrMax) && atrPct>params.atrMax+1e-9) flags.push(`ATR% ${fmt(atrPct)} > atrMax ${fmt(params.atrMax)}`);
  const zrv = Number(features?.zDeltaLogRVOL ?? features?.z_dLogRV);
  const regimeShock = Number.isFinite(zrv) && Math.abs(zrv)>=0.7;
  if(regimeShock) flags.push(`|zΔRVOL| high (${fmt(zrv)})`);
  const gapNorm = Number(features?.gapNorm);
  const gapReversal = (gapNorm>=0.5 && ret1d<0) || (gapNorm<=-0.5 && ret1d>0);

  let wrongType = 'calibration_miss';
  if (margin > 0.1) wrongType = 'features_agreed_with_wrong_call';       // model features truly pushed wrong way
  else if (rightSidePower > wrongSidePower + 0.1) wrongType = 'policy_error'; // features favored right side but threshold/cut led to wrong call
  if (gapReversal) wrongType = 'gap_reversal';
  if (regimeShock) wrongType = 'regime_shock';

  // top culprits (wrong-side contributors)
  const wrongContribs = contribs
    .filter(c => (wrongSide===1 ? c.contrib>0 : c.contrib<0))
    .sort((a,b)=>Math.abs(b.contrib)-Math.abs(a.contrib))
    .slice(0,3);

  const topUp = contribs.filter(c=>c.contrib>0).slice(0,3);
  const topDown = contribs.filter(c=>c.contrib<0).slice(0,3).map(c=>({...c, contrib: Math.abs(c.contrib)}));

  const gateBits = Object.entries(gates||{}).filter(([,v])=>v!==undefined).map(([k,v])=>`${k}:${v?'PASS':'BLOCK'}`).join(', ');
  const why = [
    `Called ${pred===1?'UP':'DOWN'} (pUp=${pUp?.toFixed?.(3)}, conf=${(Math.abs(pUp-0.5)*2).toFixed(3)})`,
    `but next day was ${actual===1?'UP':'DOWN'} (ret1d=${fmt(ret1d)}).`,
    `Wrong-side power=${fmt(wrongSidePower)}, right-side power=${fmt(rightSidePower)}, margin=${fmt(margin)}.`,
    wrongContribs.length ? `Culprits: ${wrongContribs.map(c=>`${c.name}→${fmt(c.contrib)} [${reasonForMetric(c.name,c.raw)}]`).join('; ')}.` : '',
    topUp.length ? `Top pushes toward UP: ${topUp.map(t=>`${t.name}=${fmt(t.raw)} (w=${fmt(t.weight)}, c=${fmt(t.contrib)})`).join(', ')}.` : '',
    topDown.length ? `Top pushes toward DOWN: ${topDown.map(t=>`${t.name}=${fmt(t.raw)} (w=${fmt(t.weight)}, c=${fmt(t.contrib)})`).join(', ')}.` : '',
    flags.length ? `Flags: ${flags.join('; ')}.` : '',
    gateBits ? `Gates: ${gateBits}.` : ''
  ].filter(Boolean).join(' ');

  const row = {
    symbol,date,
    actual, pred,
    pUp: Number.isFinite(pUp)?Number(pUp).toFixed(6):'',
    conf: Number.isFinite(pUp)?(Math.abs(pUp-0.5)*2).toFixed(6):'',
    ret1d: Number.isFinite(ret1d)?Number(ret1d).toFixed(6):'',
    sum_up_contrib: fmt(sumUp),
    sum_down_contrib: fmt(sumDown),
    net_margin: fmt(net),
    wrong_side_power: fmt(wrongSidePower),
    right_side_power: fmt(rightSidePower),
    margin_wrong_minus_right: fmt(margin),
    wrong_type: wrongType,
    high_conf_wrong: highConf?1:0,
    regime_flags: flags.join('|'),
    top_misleading: wrongContribs.map(c=>c.name).join('|'),
    why
  };

  // attach per-metric 4-tuple + a short reason
  contribs.forEach(({name,raw,score,weight,contrib})=>{
    row[`raw_${name}`]=Number.isFinite(raw)?raw:'';
    row[`score_${name}`]=Number.isFinite(score)?Number(score).toFixed(6):'';
    row[`w_${name}`]=Number.isFinite(weight)?Number(weight).toFixed(6):'';
    row[`contrib_${name}`]=Number.isFinite(contrib)?Number(contrib).toFixed(6):'';
    row[`reason_${name}`]=reasonForMetric(name, raw);
  });

  return { row, metrics: contribs.map(c=>c.name) };
}

/** Write dynamic CSV */
function writeWrongCsv(outPath, rows){
  if(!rows.length) return;
  const headers=new Set(); rows.forEach(r=>Object.keys(r.row).forEach(k=>headers.add(k)));
  const cols=[...headers];
  const lines=[cols.map(csvCell).join(',')];
  rows.forEach(({row})=>lines.push(cols.map(h=>csvCell(row[h])).join(',')));
  fs.mkdirSync(path.dirname(outPath),{recursive:true});
  fs.writeFileSync(outPath, lines.join('\n'),'utf8');
}

/** Old quick console table */
function summarizeBlame(rows, topN=10){
  const counts={}; rows.forEach(({row})=>{
    (row.top_misleading||'').split('|').filter(Boolean).forEach(n=>counts[n]=(counts[n]||0)+1);
  });
  const ordered=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,topN);
  if(!ordered.length) return;
  console.log('\nTop misleading metrics on wrong calls:');
  console.table(ordered.map(([metric,wrongs])=>({metric,wrongs})));
}

/** NEW: rich blame summary with totals & contexts; writes CSV too */
function summarizeBlamePlus(rows, outPath){
  const agg = {}; // metric → stats
  const bump = (m, key, v=1) => { (agg[m]??=( {metric:m, wrong_calls:0, total_wrong_contrib:0, sum_raw:0, sum_score:0, high_conf_wrongs:0, regime_shocks:0, gap_reversals:0} ))[key]+=v; };

  rows.forEach(({row})=>{
    const pred = Number(row.pred)||0, actual=Number(row.actual)||0;
    const conf = Number(row.conf)||0;
    const highConf = conf>=0.20;
    const regimeShock = (row.regime_flags||'').includes('zΔRVOL') || (row.regime_flags||'').includes('zRVOL');
    const gapUpRev = (Number(row['raw_gapNorm'])>=0.5 && Number(row.ret1d)<0);
    const gapDnRev = (Number(row['raw_gapNorm'])<=-0.5 && Number(row.ret1d)>0);
    const gapRev = gapUpRev || gapDnRev;

    // loop all metric columns present in this row
    Object.keys(row).forEach(k=>{
      if(!k.startsWith('contrib_')) return;
      const m = k.replace('contrib_','');
      const contrib = Number(row[k]);
      if(!Number.isFinite(contrib)) return;

      // Wrong-side contribution only
      const wrongSide = pred===1 ? contrib>0 : contrib<0;
      if (!wrongSide) return;

      bump(m, 'wrong_calls', 1);
      bump(m, 'total_wrong_contrib', Math.abs(contrib));
      bump(m, 'sum_raw', Math.abs(Number(row[`raw_${m}`])||0));
      bump(m, 'sum_score', Math.abs(Number(row[`score_${m}`])||0));
      if (highConf) bump(m, 'high_conf_wrongs', 1);
      if (regimeShock) bump(m, 'regime_shocks', 1);
      if (gapRev) bump(m, 'gap_reversals', 1);
    });
  });

  const table = Object.values(agg).map(o=>{
    const wc = o.wrong_calls||0;
    const avgWrongContrib = wc? o.total_wrong_contrib/wc : 0;
    const avgRaw = wc? o.sum_raw/wc : 0;
    const avgScore = wc? o.sum_score/wc : 0;
    const pctHighConf = wc? o.high_conf_wrongs/wc : 0;
    const pctRegimeShock = wc? o.regime_shocks/wc : 0;
    const pctGapRev = wc? o.gap_reversals/wc : 0;
    // sample reason (from name only)
    const sampleReason = reasonForMetric(o.metric, avgRaw);
    return {
      metric: o.metric,
      wrong_calls: wc,
      total_wrong_contrib: Number(avgWrongContrib*wc).toFixed(4),
      avg_wrong_contrib: Number(avgWrongContrib).toFixed(4),
      avg_raw_on_wrongs: fmt(avgRaw),
      avg_score_on_wrongs: Number(avgScore).toFixed(4),
      pct_high_conf_wrong: Number(pctHighConf*100).toFixed(1)+'%',
      pct_regime_shock: Number(pctRegimeShock*100).toFixed(1)+'%',
      gap_reversal_rate: Number(pctGapRev*100).toFixed(1)+'%',
      sample_reason: sampleReason
    };
  }).sort((a,b)=>Number(b.total_wrong_contrib)-Number(a.total_wrong_contrib));

  // console table
  if (table.length){
    console.log('\nMost damaging metrics (what + why + how):');
    console.table(table.slice(0,10));
  }

  // write CSV
  if (outPath){
    const cols = Object.keys(table[0] || {metric:'', wrong_calls:0});
    const lines = [cols.join(',')].concat(
      table.map(r => cols.map(c => csvCell(r[c])).join(','))
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  }

  return table;
}

module.exports = {
  buildWrongRow,
  writeWrongCsv,
  summarizeBlame,
  summarizeBlamePlus,
  canonicalName,
  computeContributions,
  dirScore,
  reasonForMetric
};

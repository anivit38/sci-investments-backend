/*****************************************************************
 * backend/data/updateCSV.js  – Phase-3 (bucket per exchange)
 *
 *  Keeps every Phase-2 column and appends Phase-3 indicators:
 *   • Volatility5d  • VWAPratio  • OBV  • NewsSentMA3d
 *
 *  Usage:
 *     node updateCSV.js                # processes all symbols.json
 *     node updateCSV.js AAPL MSFT ...   # only those tickers
 *****************************************************************/
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const fs     = require("fs");
const path   = require("path");
const readline = require("readline");
const yahoo  = require("yahoo-finance2").default;
const RSS    = require("rss-parser");
const Sent   = require("sentiment");

const rss      = new RSS();
const senti    = new Sent();
const SYMBOLS  = JSON.parse(fs.readFileSync(path.join(__dirname, "../symbols.json"), "utf8"));
const ARGS     = process.argv.slice(2);                 // optional CLI filter

const LOOKBACK = 60;    // pull 60 d so we can derive 5-day σ & OBV
const KEEP     = 45;    // write last 45 rows / symbol
const BUCKETS  = {};    // { exchange: writeStream }

const FEATURES_HEADER = [
  // ---- prices ----
  "symbol","date","open","high","low","close","adjclose","volume","dailyReturn",
  // ---- Phase-1 / 2 tech ----
  "SMA20","RSI14","MACD","BB_upper","BB_lower","ATR14",
  // ---- Phase-3 tech ----
  "Volatility5","VWAPratio","OBV","NewsSentMA3d",
  // ---- fundamentals ----
  "peRatio","earningsGrowth","debtToEquity","revenue","netIncome"
].join(",");

// ───────────────────────── indicator helpers ─────────────────────────
const sma = (arr,n,i)=>(i<n-1?0:arr.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n);
const stdev = (arr,n,i)=>{ if(i<n-1) return 0; const m=sma(arr,n,i); return Math.sqrt(arr.slice(i-n+1,i+1).reduce((s,x)=>s+(x-m)**2,0)/n); };
const ema = (arr,period,i)=>{ const k=2/(period+1); let prev=arr[0]; for(let j=1;j<=i;j++) prev=arr[j]*k+prev*(1-k); return prev; };
const vwapDay = d => (d.close + d.high + d.low) / 3;

// sentiment cache
const feedCache = {};
async function daySent(symbol, dateStr){
  if(!feedCache[symbol]){
    const url = `https://news.google.com/rss/search?q=${symbol}`;
    feedCache[symbol] = await rss.parseURL(url);
  }
  const t0 = new Date(dateStr).getTime(), t1 = t0 + 864e5;
  const items = feedCache[symbol].items.filter(it=>{
    const t = new Date(it.pubDate||0).getTime();
    return t>=t0 && t<t1;
  }).slice(0,3);
  if(!items.length) return 0;
  return items.reduce((a,it)=>a+senti.analyze(it.title||"").score,0)/items.length;
}

// open bucket stream (once per exchange)
function bucket(ex){
  if(BUCKETS[ex]) return BUCKETS[ex];
  const fp = path.join(__dirname, `${ex}.csv`);
  const ws = fs.createWriteStream(fp);
  ws.write(FEATURES_HEADER + "\n");
  BUCKETS[ex] = ws;
  return ws;
}

// ───────────────────────── main loop ─────────────────────────
(async () => {
  const todo = SYMBOLS.filter(s => !ARGS.length || ARGS.includes(s.symbol));

  for (const { symbol: sym, ex } of todo) {
    process.stdout.write(`▶ ${sym} `);
    let raw;
    try {
      const end = new Date();
      const start = new Date(end); start.setDate(end.getDate() - LOOKBACK);
      raw = await yahoo.historical(sym, { period1: start, period2: end, interval: "1d" });
    } catch { console.log("skip"); continue; }

    if (!raw?.length) { console.log("skip"); continue; }
    raw.sort((a,b)=>new Date(a.date)-new Date(b.date));

    // arrays for quick access
    const closes = raw.map(r=>r.close);
    const highs  = raw.map(r=>r.high);
    const lows   = raw.map(r=>r.low);
    const vols   = raw.map(r=>r.volume);

    // tech indicators
    const sma20 = closes.map((_,i)=>sma(closes,20,i));
    const rsi14 = closes.map((_,i)=>{
      if(i<14) return 0;
      let g=0,l=0;
      for(let k=i-13;k<=i;k++){
        const diff = closes[k]-closes[k-1];
        diff>0 ? g+=diff : l-=diff;
      }
      const rs = l ? (g/14)/(l/14) : 100;
      return 100 - 100/(1+rs);
    });
    const macd = closes.map((_,i)=> i<26 ? 0 : ema(closes,12,i) - ema(closes,26,i));
    const bb   = closes.map((_,i)=> i<19 ? {u:0,l:0} : {u:sma(closes,20,i)+2*stdev(closes,20,i), l:sma(closes,20,i)-2*stdev(closes,20,i)});
    const atr14= closes.map((_,i)=>{
      if(i<14) return 0;
      let sum=0;
      for(let k=i-13;k<=i;k++){
        const prev = closes[k-1]??closes[k];
        const tr = Math.max(highs[k]-lows[k], Math.abs(highs[k]-prev), Math.abs(lows[k]-prev));
        sum+=tr;
      }
      return sum/14;
    });
    const vol5 = closes.map((_,i)=>stdev(closes,5,i));
    const vwapR= raw.map(d=> d.close / vwapDay(d));
    const obv  = (()=>{ const arr=[],o=[]; raw.forEach((d,i)=>{ if(i===0){o.push(0);return;} arr[i]=(arr[i-1]??0)+d.volume*Math.sign(d.close-closes[i-1]); o.push(arr[i]);}); return o;})();
    const sent = [];
    for(let i=0;i<raw.length;i++){
      const ds = raw[i].date.toISOString().slice(0,10);
      sent.push(await daySent(sym,ds));
    }
    const sentMA3 = sent.map((_,i)=>sma(sent,3,i));

    // write last KEEP rows
    const startRow = Math.max(0, raw.length-KEEP);
    const ws = bucket(ex);
    for(let i=startRow;i<raw.length;i++){
      const d = raw[i];
      const prevClose = i ? raw[i-1].close : d.close;
      const line = [
        sym,
        d.date.toISOString().slice(0,10),
        d.open, d.high, d.low, d.close, d.adjclose ?? d.close, d.volume,
        (d.close/prevClose-1).toFixed(6),
        sma20[i], rsi14[i], macd[i], bb[i].u, bb[i].l, atr14[i],
        vol5[i], vwapR[i], obv[i], sentMA3[i],
        d.peRatio??0, d.earningsGrowth??0, d.debtToEquity??0, d.revenue??0, d.netIncome??0
      ].join(",");
      ws.write(line + "\n");
      process.stdout.write(".");
    }
    console.log("");
  }

  Object.values(BUCKETS).forEach(ws=>ws.end());
  console.log("✅ Buckets written:", Object.keys(BUCKETS).join(", "));
})();

/*****************************************************************
 * dailyForecast.js   Phase-3  (reads NASDAQ.csv, NYSE.csv, …)
 *
 *  • Pulls the most-recent 30 rows for each requested symbol
 *    straight from its exchange bucket.
 *  • Uses predictNextDay() from trainGRU.js
 *  • Appends one line to dailyForecasts.csv
 *
 *  CLI:   node dailyForecast.js AAPL MSFT TSLA
 *****************************************************************/
const fs   = require('fs');
const path = require('path');
const rl   = require('readline');
const { FEATURES, LOOKBACK }  = require('./prepareData');   // 23-col list
const { predictNextDay }      = require('./trainGRU');

const BKT = { NASDAQ:'NASDAQ.csv', NYSE:'NYSE.csv', TSX:'TSX.csv' };
const SYMBOLS = JSON.parse(
  fs.readFileSync(path.join(__dirname,'symbols.json'),'utf8')
);

const DATA_DIR = path.join(__dirname, 'data');
const OUT_CSV  = path.join(__dirname, 'dailyForecasts.csv');

// ── helper: stream-grab last 30 rows for one symbol ───────────
function getWindow(symbol){
  const { ex } = SYMBOLS.find(s=>s.symbol===symbol) || {};
  if(!ex) throw new Error(`exchange for ${symbol} not found`);
  const fp = path.join(DATA_DIR, BKT[ex]);
  if(!fs.existsSync(fp)) throw new Error(`${BKT[ex]} missing; run updateCSV`);

  const win=[];                               // sliding buffer
  return new Promise(res=>{
    rl.createInterface({input:fs.createReadStream(fp)})
      .on('line',line=>{
        if(!line.startsWith(symbol+',')) return;
        const parts=line.split(',');
        win.push(parts); if(win.length>LOOKBACK) win.shift();
      })
      .on('close',()=>{
        if(win.length<LOOKBACK) throw new Error('insufficient history');
        // map → numeric feature matrix 30×FEATURES.length
        const mat = win.map(row =>
          FEATURES.map((f,i)=> +row[i+2] || 0)   // +2 => skip symbol,date
        );
        res(mat);
      });
  });
}

// ── main ──────────────────────────────────────────────────────
(async()=>{
  const syms = process.argv.slice(2);
  if(!syms.length){
    console.error('Usage: node dailyForecast.js <SYM1> [SYM2 …]');
    process.exit(1);
  }

  const tomorrowISO = (()=>{ const d=new Date(); d.setDate(d.getDate()+1);
    while([0,6].includes(d.getDay())) d.setDate(d.getDate()+1);
    return d.toISOString().slice(0,10);
  })();

  const outLines = ['symbol,currentClose,forecastClose,forecastDate'];

  for(const sym of syms){
    try{
      const window = await getWindow(sym);                    // 30×23
      const currentClose = window[LOOKBACK-1][ FEATURES.indexOf('close') ];
      const forecast = await predictNextDay(sym, window);
      console.log(`✅ ${sym} → ${forecast.toFixed(2)}`);
      outLines.push([sym,currentClose.toFixed(2),forecast.toFixed(2),tomorrowISO].join(','));
    }catch(e){
      console.warn(`⚠️  ${sym}: ${e.message}`);
    }
  }

  fs.writeFileSync(OUT_CSV, outLines.join('\n'),'utf8');
  console.log(`📄  Forecasts written → ${OUT_CSV}`);
})();

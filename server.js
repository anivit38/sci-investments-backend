/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, FORECASTING, COMMUNITY
 *******************************************/

require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const bodyParser   = require("body-parser");
const bcrypt       = require("bcryptjs");
const jwt          = require("jsonwebtoken");
const mongoose     = require("mongoose");
const path         = require("path");
const fs           = require("fs");
const tf           = require("@tensorflow/tfjs-node");
const yahooFinance = require("yahoo-finance2").default;
const nodemailer   = require("nodemailer");
const rateLimit    = require("express-rate-limit");
const app          = express();

/* extras */
const crypto      = require("crypto");
const RSSParser   = require("rss-parser");
const Sentiment   = require("sentiment");
const fetchNative = require("node-fetch");
const cheerio     = require("cheerio");

/*──────────────────────────────────────────
|  GLOBAL DATA                             |
└──────────────────────────────────────────*/
const symbolsList = JSON.parse(
  fs.readFileSync(path.join(__dirname, "symbols.json"), "utf8")
);
const rssParser  = new RSSParser();
const sentiment  = new Sentiment();
const { predictNextDay } = require("./data/trainGRU"); // GRU helper

/*──────────────────────────────────────────
|  SINGLE CORS MIDDLEWARE (no duplicates)  |
└──────────────────────────────────────────*/
app.use(
  cors({
    origin: ["https://sci-investments.web.app", "http://localhost:3000"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.options("*", cors());
app.use(bodyParser.json());

/*──────────────────────────────────────────
|  TIME‑SERIES CONFIG                      |
└──────────────────────────────────────────*/
const TIME_SERIES_WINDOW    = 30;
const FORECAST_FEATURE_KEYS = [
  "open","high","low","close","volume",
  "peRatio","earningsGrowth","debtToEquity","revenue","netIncome",
  "ATR14","SMA20","STD20","BB_upper","BB_lower","RSI14","MACD"
];

/*──────────────────────────────────────────
|  CSV cache helpers                       |
└──────────────────────────────────────────*/
const { loadCsvIntoMemory,
        getCachedHistoricalData,
        fetchAllSymbolsHistoricalData } = require("./fetchData");
loadCsvIntoMemory();

/*──────────────────────────────────────────
|  Nodemailer (unchanged)                  |
└──────────────────────────────────────────*/
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: { user: process.env.NOTIFY_EMAIL, pass: process.env.NOTIFY_PASSWORD },
});
function sendSellNotification(symbol, price, reasons) {
  transporter.sendMail(
    {
      from: process.env.NOTIFY_EMAIL,
      to:   process.env.NOTIFY_RECIPIENT,
      subject: `Sell Alert: ${symbol}`,
      text: `[AutoSell] Selling ${symbol} at $${price}. Reasons: ${reasons.join(", ")}`,
    },
    err => err && console.error("Mailer error:", err)
  );
}

/*──────────────────────────────────────────
|  Small helpers                           |
└──────────────────────────────────────────*/
const fetch = (...a)=>import("node-fetch").then(({default:f})=>f(...a));
const delay = ms=>new Promise(r=>setTimeout(r,ms));

function isMarketOpen(){
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const d=et.getDay(),h=et.getHours(),m=et.getMinutes();
  if(d===0||d===6) return false;
  if(h<9||(h===9&&m<30)) return false;
  if(h>16||(h===16&&m>0)) return false;
  return true;
}
function getForecastEndTime(){
  const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  let label;
  if(isMarketOpen()&&et.getHours()<16){ et.setHours(16,0,0,0); label="Today";}
  else{ do{et.setDate(et.getDate()+1);}while([0,6].includes(et.getDay()));
        et.setHours(16,0,0,0); label="Next Trading Day";}
  return `${label}, 4:00pm, ${String(et.getMonth()+1).padStart(2,"0")}/${String(et.getDate()).padStart(2,"0")}/${et.getFullYear()}`;
}

/*──────────────────────────────────────────
|  Mongo models/setup                      |
└──────────────────────────────────────────*/
const UserModel = require(path.join(__dirname,"models","User"));
const communityPostSchema = new mongoose.Schema({
  username:String,
  message:String,
  createdAt:{type:Date,default:Date.now},
});
const CommunityPost = mongoose.model("CommunityPost",communityPostSchema);

let industryMetrics={};
try{ industryMetrics=require("./industryMetrics.json"); }catch{}

mongoose.connect(process.env.MONGODB_URI||"mongodb://127.0.0.1:27017/sci_investments",{
  useNewUrlParser:true,
  useUnifiedTopology:true,
  serverSelectionTimeoutMS:5000,
  socketTimeoutMS:45000,
}).then(()=>console.log("✅ Connected to MongoDB"))
  .catch(e=>console.error("❌ MongoDB:",e.message));
mongoose.set("debug",true);
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";

/*──────────────────────────────────────────
|  Forecast model load (unchanged)         |
└──────────────────────────────────────────*/
let forecastModel=null, normalizationParams=null;
(async()=>{
  try{
    forecastModel = await tf.loadLayersModel("file://model/forecast_model/model.json");
    const p=path.join(__dirname,"model","forecast_model","normalization.json");
    if(fs.existsSync(p)) normalizationParams=JSON.parse(fs.readFileSync(p,"utf8"));
    console.log("✅ Forecast resources ready");
  }catch(e){ console.warn("⚠️ Forecast model skipped:",e.message); }
})();

/*──────────────────────────────────────────
|  Caches                                  |
└──────────────────────────────────────────*/
const forecastCache={};
const FORECAST_CACHE_TTL = 24*60*60*1000; // 24 h

const stockDataCache={};
const CACHE_TTL=60*60*1000;               // 60 min (was 15)

/*──────────────────────────────────────────
|  Yahoo fetch wrapper                     |
└──────────────────────────────────────────*/
const requestOptions={
  headers:{"User-Agent":"Mozilla/5.0"},
  redirect:"follow",
};
async function fetchStockData(symbol){
  const now=Date.now();
  if(stockDataCache[symbol] && now-stockDataCache[symbol].timestamp<CACHE_TTL)
    return stockDataCache[symbol].data;
  console.log("Fetching fresh data for",symbol);
  try{
    const data=await yahooFinance.quoteSummary(
      symbol,
      {modules:["financialData","price","summaryDetail","defaultKeyStatistics","assetProfile"],validateResult:false},
      {fetchOptions:requestOptions}
    );
    if(!data||!data.price) throw new Error("Invalid data from Yahoo");
    stockDataCache[symbol]={data,timestamp:now};
    return data;
  }catch(e){
    console.error(`❌ Yahoo fetch ${symbol}:`,e.message);
    return null;
  }
}

/*──────────────────────────────────────────
|  Time‑series from cached CSV             |
└──────────────────────────────────────────*/
async function fetchTimeSeriesData(symbol,days=TIME_SERIES_WINDOW){
  const hist=getCachedHistoricalData(symbol);
  if(!hist||!hist.length) throw new Error("No cached history");
  hist.sort((a,b)=>new Date(a.date)-new Date(b.date));
  return hist.slice(-days);
}

/*──────────────────────────────────────────
|  Forecast helpers (unchanged algorithms) |
└──────────────────────────────────────────*/
async function simpleForecastPrice(symbol,price){
  const hist=getCachedHistoricalData(symbol);
  if(!hist||hist.length<5) return price;
  hist.sort((a,b)=>new Date(a.date)-new Date(b.date));
  const recent=hist.slice(-10);
  const pct=recent.reduce((s,d)=>(d.open&&d.close)?s+(d.close-d.open)/d.open:s,0)/recent.length||0;
  return price*(1+pct);
}
const BUCKET={NASDAQ:"NASDAQ.csv",NYSE:"NYSE.csv",TSX:"TSX.csv"};
async function getWindowFromBucket(symbol){
  const entry=symbolsList.find(s=>(s.symbol||s)===symbol);
  if(!entry) throw new Error("exchange unknown");
  const file=path.join(__dirname,"data",BUCKET[entry.exchange||entry.ex]);
  if(!fs.existsSync(file)) throw new Error("bucket CSV missing");
  const rows=[];
  await new Promise(r=>{
    require("readline").createInterface({input:fs.createReadStream(file)})
      .on("line",l=>{
        if(!l.startsWith(symbol+",")) return;
        rows.push(l.split(","));
        if(rows.length>30) rows.shift();
      })
      .on("close",r);
  });
  if(rows.length<30) throw new Error("not enough history");
  return rows.map(r=>FORECAST_FEATURE_KEYS.map((_,i)=>+r[i+2]||0));
}
async function buildForecastPrice(symbol,price){
  if(forecastCache[symbol] && Date.now()-forecastCache[symbol].timestamp<FORECAST_CACHE_TTL)
    return forecastCache[symbol].price;
  let adv=null;
  try{ adv=await predictNextDay(symbol,await getWindowFromBucket(symbol)); }catch{}
  const simple=await simpleForecastPrice(symbol,price);
  const final=adv&&Math.abs(adv-price)>0.01?adv:simple;
  forecastCache[symbol]={price:final,timestamp:Date.now()};
  return final;
}

/*──────────────────────────────────────────
|  Rate‑limits                             |
└──────────────────────────────────────────*/
const stockCheckerLimiter = rateLimit({windowMs:60*1000,max:5,message:{message:"Too many requests, please try again shortly."}});
app.use("/api/check-stock", stockCheckerLimiter);

const findStockLimiter = rateLimit({windowMs:60*1000,max:5,message:{message:"Too many requests, please try again shortly."}});
app.use("/finder/api/find-stocks", findStockLimiter); // correct path

/*──────────────────────────────────────────
|  ===  REST ENDPOINTS (all original)  === |
└──────────────────────────────────────────*/
/*──────────────────────────────────────────
|  11) Auth Endpoints                      |
└──────────────────────────────────────────*/
app.get("/", (_req, res) => res.send("✅ Combined Server is running!"));

app.post("/signup", async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password)
    return res.status(400).json({ message: "All fields are required." });
  try {
    if (await UserModel.findOne({ email }))
      return res.status(400).json({ message: "Email already in use." });
    await new UserModel({
      email,
      username,
      password: await bcrypt.hash(password, 10),
    }).save();
    return res.status(201).json({ message: "User registered successfully." });
  } catch (e) {
    console.error("Signup error:", e.message);
    return res.status(500).json({ message: "Error during signup." });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: "Email and password are required." });
  try {
    const user = await UserModel.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: "Invalid credentials." });
    const token = jwt.sign({ userId: user._id, email }, JWT_SECRET, {
      expiresIn: "24h",
    });
    return res.json({ message: "Login successful.", token });
  } catch (e) {
    console.error("Login error:", e.message);
    return res.status(500).json({ message: "Error during login." });
  }
});

app.get("/protected", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token required." });
  try {
    return res.json({ user: jwt.verify(token, JWT_SECRET) });
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
});

/*──────────────────────────────────────────
|  12) STOCK CHECKER                       |
└──────────────────────────────────────────*/
app.post("/api/check-stock", async (req, res) => {
  const { symbol, intent } = req.body;
  if (!symbol || !intent)
    return res.status(400).json({ message: "symbol & intent required." });

  /* fetch current fundamentals (with 1‑hour cache) */
  const stock = await fetchStockData(symbol.toUpperCase());
  if (!stock || !stock.price)
    return res.status(404).json({ message: "Stock not found or data unavailable." });

  const metrics = {
    volume:            stock.price.regularMarketVolume ?? 0,
    currentPrice:      stock.price.regularMarketPrice ?? 0,
    peRatio:           stock.summaryDetail.trailingPE ?? 0,
    pbRatio:           stock.summaryDetail.priceToBook ?? 0,
    dividendYield:     stock.summaryDetail.dividendYield ?? 0,
    earningsGrowth:    stock.financialData.earningsGrowth ?? 0,
    debtRatio:         stock.financialData.debtToEquity ?? 0,
    dayHigh:           stock.price.regularMarketDayHigh ?? 0,
    dayLow:            stock.price.regularMarketDayLow ?? 0,
    fiftyTwoWeekHigh:  stock.summaryDetail.fiftyTwoWeekHigh ?? 0,
    fiftyTwoWeekLow:   stock.summaryDetail.fiftyTwoWeekLow ?? 0,
  };
  const avgVol = stock.summaryDetail.averageDailyVolume3Month ?? metrics.volume;

  /* fundamental rating (unchanged formula) */
  let rating = 0;
  if (metrics.volume > avgVol * 1.2) rating += 3;
  else if (metrics.volume < avgVol * 0.8) rating -= 2;
  if (metrics.peRatio >= 5 && metrics.peRatio <= 25) rating += 2;
  else if (metrics.peRatio > 30) rating -= 1;
  if (metrics.earningsGrowth > 0.15) rating += 4;
  else if (metrics.earningsGrowth > 0.03) rating += 2;
  else if (metrics.earningsGrowth < 0) rating -= 2;
  if (metrics.debtRatio < 0.3) rating += 3;
  else if (metrics.debtRatio > 1) rating -= 1;

  /* quick min/max positioning */
  const dayPos   = (metrics.currentPrice - metrics.dayLow) /
                   (metrics.dayHigh - metrics.dayLow || 1);
  const weekPos  = (metrics.currentPrice - metrics.fiftyTwoWeekLow) /
                   (metrics.fiftyTwoWeekHigh - metrics.fiftyTwoWeekLow || 1);
  if (dayPos < 0.2)  rating += 1;
  if (dayPos > 0.8)  rating -= 1;
  if (weekPos < 0.3) rating += 2;
  if (weekPos > 0.8) rating -= 2;

  /* industry comparison (if available) */
  const ind = industryMetrics[stock.assetProfile?.industry];
  if (ind) {
    if (metrics.peRatio && ind.peRatio)
      rating += metrics.peRatio < ind.peRatio ? 2 : -2;
    if (metrics.earningsGrowth && ind.revenueGrowth)
      rating += metrics.earningsGrowth * 100 > ind.revenueGrowth ? 2 : -2;
    if (metrics.debtRatio && ind.debtToEquity)
      rating += metrics.debtRatio < ind.debtToEquity ? 2 : -2;
  }

  /* forecast price (cached / GRU / fallback) */
  const forecastPrice = await buildForecastPrice(
    symbol.toUpperCase(),
    metrics.currentPrice
  );
  const growthPct = ((forecastPrice - metrics.currentPrice) /
                     metrics.currentPrice) * 100;
  const classification =
    growthPct >= 2  ? "growth"   :
    growthPct >= 0  ? "stable"   :
                      "unstable";
  const advice = classification === "growth"
    ? "Projected to grow. Consider buying."
    : classification === "stable"
    ? "Minimal growth expected. Hold or monitor."
    : "Projected to decline. Consider selling or avoiding.";

  /* news sentiment (unchanged) */
  let news = { averageSentiment: 0, topStories: [] };
  try {
    const feed = await rssParser.parseURL(
      `https://news.google.com/rss/search?q=${symbol}`
    );
    const stories = feed.items.slice(0, 5);
    const analyses = await Promise.all(stories.map(async item => {
      let snippet = item.contentSnippet || item.title;
      try {
        const html = await (await fetchNative(item.link)).text();
        snippet = cheerio.load(html)("p").first().text() || snippet;
      } catch {}
      return {
        title: item.title,
        link : item.link,
        snippet: snippet.slice(0,200) + (snippet.length>200 ? "…" : ""),
        sentiment: sentiment.analyze(snippet).score,
      };
    }));
    news = {
      averageSentiment: analyses.reduce((s,a)=>s+a.sentiment,0)/analyses.length || 0,
      topStories: analyses,
    };
  } catch(e){ console.warn("News fetch failed:", e.message); }

  return res.json({
    symbol: symbol.toUpperCase(),
    name  : stock.price.longName || symbol.toUpperCase(),
    industry: stock.assetProfile?.industry || "Unknown",
    fundamentalRating: rating.toFixed(2),
    forecast: {
      forecastPrice: +forecastPrice.toFixed(2),
      projectedGrowthPercent: `${growthPct.toFixed(2)}%`,
      forecastEndDate: getForecastEndTime(),
    },
    classification,
    advice,
    news,
  });
});

/*──────────────────────────────────────────
|  13) FINDER (rate‑limited)               |
└──────────────────────────────────────────*/
const finderRouter = express.Router();

finderRouter.post("/api/find-stocks", async (req, res) => {
  let { stockType, exchange, minPrice, maxPrice } = req.body;
  if (!stockType || !exchange) return res.status(400).json({ message:"Bad params" });
  stockType = stockType.toLowerCase();
  exchange  = exchange.toUpperCase();

  const out=[];
  for (const s of symbolsList){
    const sym  = typeof s === "string" ? s : s.symbol;
    const exch = typeof s === "string" ? "N/A" : s.exchange || "N/A";
    if (exch.toUpperCase()!==exchange) continue;

    const data = await fetchStockData(sym);
    if (!data||!data.price) continue;
    const price=data.price.regularMarketPrice;
    if (price<minPrice||price>maxPrice) continue;

    const { classification } = await classifyStockByForecast(sym);
    if (classification===stockType) out.push({ symbol:sym, exchange:exch });
  }
  return res.json({ stocks: out });
});

app.use("/finder", finderRouter);

/*──────────────────────────────────────────
|  14) Popular / top‑forecast / news       |
└──────────────────────────────────────────*/
app.get("/api/popular-stocks", async (_req,res)=>{
  const popular=["AAPL","TSLA","AMZN","NVDA","META","GOOG","MSFT"];
  const rows=[];
  for (const sym of popular){
    const d=await fetchStockData(sym);
    if(d&&d.price) rows.push({
      symbol:sym,
      name  :d.price.longName||sym,
      price :d.price.regularMarketPrice,
      volume:d.price.regularMarketVolume,
    });
  }
  return res.json({ stocks: rows });
});

app.get("/api/top-forecasted", async (_req,res)=>{
  const sample = symbolsList.slice(0,200).map(s=>typeof s==="string"?s:s.symbol);
  const rows=[];
  for (const sym of sample){
    const d=await fetchStockData(sym);
    const p=d?.price?.regularMarketPrice;
    if(!p) continue;
    const fc=await buildForecastPrice(sym,p);
    rows.push({symbol:sym,gain:((fc-p)/p)*100});
  }
  rows.sort((a,b)=>b.gain-a.gain);
  res.json({ forecasts: rows.slice(0,5) });
});

app.get("/api/top-news", async (_req,res)=>{
  try{
    const feed=await rssParser.parseURL("https://news.google.com/rss/search?q=stock+market");
    res.json({ headlines: feed.items.slice(0,5).map(i=>({title:i.title,url:i.link})) });
  }catch(e){
    res.status(500).json({ headlines: [] });
  }
});

/*──────────────────────────────────────────
|  15) Community                           |
└──────────────────────────────────────────*/
app.get("/api/community-posts", async (_req,res)=>{
  res.json({ posts: await CommunityPost.find().sort({createdAt:-1}) });
});
app.post("/api/community-posts", async (req,res)=>{
  const { username,message } = req.body;
  if(!username||!message) return res.status(400).json({ message:"username & message required" });
  await new CommunityPost({username,message}).save();
  res.status(201).json({ message:"Post created." });
});

/*──────────────────────────────────────────
|  16) Forgot / Reset password             |
└──────────────────────────────────────────*/
app.post("/forgotPassword", async (req,res)=>{
  const { email } = req.body;
  if(!email) return res.status(400).json({ message:"Email required." });
  const user = await UserModel.findOne({ email });
  if(!user) return res.status(404).json({ message:"No account with that email." });

  const token = crypto.randomBytes(20).toString("hex");
  user.resetPasswordToken   = token;
  user.resetPasswordExpires = Date.now()+3600000;
  await user.save();

  await transporter.sendMail({
    from: process.env.NOTIFY_EMAIL,
    to  : user.email,
    subject: "Password Reset Request",
    text: `Reset link (valid 1 h): https://sci-investments.web.app/resetPassword.html?token=${token}`,
  });
  res.json({ message:"Reset link sent." });
});

app.post("/resetPassword", async (req,res)=>{
  const { token,newPassword } = req.body;
  if(!token||!newPassword) return res.status(400).json({ message:"token & newPassword required" });
  const user = await UserModel.findOne({
    resetPasswordToken:token,
    resetPasswordExpires:{ $gt:Date.now() },
  });
  if(!user) return res.status(400).json({ message:"Token invalid or expired." });
  user.password = await bcrypt.hash(newPassword,10);
  user.resetPasswordToken=undefined;
  user.resetPasswordExpires=undefined;
  await user.save();
  res.json({ message:"Password reset successful!" });
});

/*──────────────────────────────────────────
|  17) Automated‑investor & daily job      |
└──────────────────────────────────────────*/
// ────────────────────────────────────────────────────────────
// 18) AUTOMATED INVESTOR SECTION
// ────────────────────────────────────────────────────────────
const SYMBOLS_JSON_PATH   = path.join(__dirname, "symbols.json");
const PORTFOLIO_JSON_PATH = path.join(__dirname, "portfolio.json");

let allStocks = [];
if (fs.existsSync(SYMBOLS_JSON_PATH)) {
  try {
    const rawContent = fs.readFileSync(SYMBOLS_JSON_PATH, "utf-8");
    allStocks = JSON.parse(rawContent);
    console.log(`✅ Loaded ${allStocks.length} stocks from symbols.json`);
  } catch (err) {
    console.error("Error parsing symbols.json:", err);
    allStocks = [];
  }
} else {
  console.warn("⚠️ No symbols.json found. Automated investor will skip buying.");
}

let portfolio = fs.existsSync(PORTFOLIO_JSON_PATH)
  ? JSON.parse(fs.readFileSync(PORTFOLIO_JSON_PATH, "utf-8"))
  : [];

function savePortfolio() {
  fs.writeFileSync(PORTFOLIO_JSON_PATH, JSON.stringify(portfolio, null, 2));
}

async function getFilteredSymbols(stockType, exchange, minPrice, maxPrice) {
  const filteredSymbols = [];
  const batchSize = 10;

  for (let i = 0; i < allStocks.length; i += batchSize) {
    const batch = allStocks.slice(i, i + batchSize);

    for (const s of batch) {
      const symbol = typeof s === "string" ? s : s.symbol;
      if (s.exchange && s.exchange !== exchange) continue;

      try {
        const data = await fetchStockData(symbol);
        if (!data || !data.price) continue;

        const price = data.price.regularMarketPrice;
        if (!price || price < minPrice || price > maxPrice) continue;

        filteredSymbols.push(symbol);
      } catch (err) {
        console.error(`Filtering: Skipping ${symbol} due to error:`, err.message);
      }
    }

    await delay(5000);  // polite pause between batches
  }

  console.log(`Filtered symbols count: ${filteredSymbols.length}`);
  return filteredSymbols;
}

async function autoBuyStocks() {
  if (!isMarketOpen()) return;           // only run during market hours

  const stockType = "growth";
  const exchange  = "NASDAQ";
  const minPrice  = 10;
  const maxPrice  = 100;

  const picks = await getFilteredSymbols(stockType, exchange, minPrice, maxPrice);

  for (const symbol of picks) {
    try {
      console.log(`autoBuyStocks would analyze ${symbol} here…`);
      //  – your decision logic / portfolio updates go here –
    } catch (e) {
      console.error(`Error analyzing ${symbol}:`, e.message);
    }
  }
}

async function autoSellStocks() {
  if (!isMarketOpen()) return;
  //  – implement your auto‑sell logic here –
}

// Example scheduler (disabled by default):
// setInterval(async () => {
//   try {
//     await autoBuyStocks();
//     await autoSellStocks();
//   } catch (err) {
//     console.error("Automated‑investor task error:", err.message);
//   }
// }, 60_000);

// ────────────────────────────────────────────────────────────
// 18‑B) Daily Job: Refresh All Historical Data
// ────────────────────────────────────────────────────────────
const ONE_DAY = 24 * 60 * 60 * 1000;

async function refreshAllHistoricalData() {
  try {
    if (!fs.existsSync(SYMBOLS_JSON_PATH)) {
      console.log("No symbols.json found, skipping daily historical fetch.");
      return;
    }

    const symbols = JSON.parse(fs.readFileSync(SYMBOLS_JSON_PATH, "utf-8"));
    await fetchAllSymbolsHistoricalData(symbols, 1);   // 1‑day look‑back
  } catch (err) {
    console.error("Error in refreshAllHistoricalData:", err.message);
  }
}

// initial run at boot
refreshAllHistoricalData();

// run once every 24 h
setInterval(() => {
  console.log("⏰ Running daily refreshAllHistoricalData…");
  refreshAllHistoricalData();
}, ONE_DAY);


/*──────────────────────────────────────────
|  Start server                            |
└──────────────────────────────────────────*/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Combined server running on port ${PORT}`));

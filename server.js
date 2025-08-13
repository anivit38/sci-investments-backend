/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, FORECASTING, COMMUNITY
 *******************************************/

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const bcrypt     = require('bcryptjs');
const admin      = require('firebase-admin');
const mongoose   = require('mongoose');
const path       = require('path');
const fs         = require('fs');
const tf         = require('@tensorflow/tfjs-node');
const yahooFinance = require('yahoo-finance2').default;
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');
const axios      = require('axios');
const { getFundamentals } = require('./services/FundamentalsService');
const { getTechnical, getTechnicalForUser } = require('./services/TechnicalService');
const { getIntradayIndicators } = require('./services/IntradayService'); 
const analyzeRouter      = require('./routes/analyze');
const userProfileRoutes  = require('./routes/userProfileRoutes');
const advisorRouter = require('./routes/advisorRoutes');
const UserProfile        = require('./models/UserProfile');
const RSSParser = require('rss-parser');
const Sentiment = require('sentiment');
const rssParser = new RSSParser();
const sentiment = new Sentiment();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';


// ---- Firebase Admin init (uses GOOGLE_SERVICE_ACCOUNT_KEY from env) ----
const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
if (!raw) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_KEY env var');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(raw); // <- this is the line you asked about
} catch (e) {
  console.error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON (did you paste one-line JSON into .env?):', e.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}


// ─── CORS ────────────────────────────────────────────────────────────────────

const corsOptions = {
  origin: ['https://sci-investments.web.app','http://localhost:3000'],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Accept','x-user-id'],
  credentials: true,
  optionsSuccessStatus: 200,
};



app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.options('/api/completeOnboarding', cors(corsOptions));
app.use(express.static(path.join(__dirname, "../public")));

// ─── BODY PARSER ───────────────────────────────────────────────────────────────

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'Authorization header missing or malformed' });
  }
  const idToken = header.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = { userId: decoded.uid, email: decoded.email };
    return next();
  } catch (err) {
    console.error('Firebase Auth verify failed:', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/*──────────────────────────────────────────
|  GLOBAL DATA                             |
└──────────────────────────────────────────*/
const symbolsList = JSON.parse(
  fs.readFileSync(path.join(__dirname, "symbols.json"), "utf8")
);

const { predictNextDay } = require("./data/trainGRU"); // GRU helper


// Make sure this comes after `app.use(bodyParser.json());`
// Complete onboarding: save profile + get welcome text from CF
app.post(
  "/api/completeOnboarding",
  cors(corsOptions),
  authenticate, // ← protect and populate req.user
  async (req, res) => {
    console.log("🔥 COMPLETE ONBOARDING ROUTE HIT for user:", req.user?.userId);
    try {
      const userId  = req.user.userId;
      const answers = req.body;

      // 1) Save all answers into your UserProfile collection
      await UserProfile.findOneAndUpdate(
        { userId },
        { userId, ...answers },
        { upsert: true, new: true }
      );

      // 2) Build the prompt
      const systemPrompt = `
You are a personal AI financial advisor. Below is the user's profile:
• Experience: ${answers.experience}
• Risk tolerance: ${answers.riskTolerance}
• Investment horizon: ${answers.horizon}
• Portfolio size: ${answers.portfolioSize}
• Primary goals: ${answers.goals}
• Annual income: ${answers.incomeRange}
• Percent of income to invest: ${answers.investPct}
• Current age: ${answers.currentAge}
• Desired retirement age: ${answers.retireAge}
• Desired retirement income: ${answers.retireIncome}
• Sector interests: ${answers.sectors?.join(", ") || "none"}
• Notes: ${answers.notes || "none"}

Please generate a friendly, concise welcome message (under 100 words) that:
1) Acknowledges their profile  
2) Explains how the AI can help  
3) Invites them to start chatting.
      `.trim();

      // 3) Call your CF
      const cfUrl =
        process.env.NODE_ENV === "production"
          ? "https://us-central1-sci-investments.cloudfunctions.net/onboardAI"
          : "http://127.0.0.1:5001/sci-investments/us-central1/onboardAI";

      const cfResp = await axios.post(cfUrl, {
        symbol: "N/A",
        prompt: systemPrompt,
      });

      // 4) Send back welcome text
      return res.json({ welcomeText: cfResp.data.text });
    } catch (err) {
      console.error("completeOnboarding error:", err);
      const status = err.response?.status || 500;
      return res.status(status).json({ error: err.message });
    }
  }
);

// ─── ROUTES MOUNT ──────────────────────────────────────────────────────────────
app.use('/api', analyzeRouter);
app.use('/api', userProfileRoutes);     // uses the same authenticate() inside
app.use('/api', advisorRouter);


/* extras */
const crypto      = require("crypto");
const fetchNative = require("node-fetch");
const cheerio     = require("cheerio");


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

const requestOptions = {
  headers: { "User-Agent": "Mozilla/5.0" },
  redirect: "follow",
};

async function fetchStockData(symbol) {
  const now = Date.now();

  /* use cache if still fresh */
  if (
    stockDataCache[symbol] &&
    now - stockDataCache[symbol].timestamp < CACHE_TTL
  ) {
    return stockDataCache[symbol].data;
  }

  /* 1️⃣ try the rich quoteSummary call first */
  try {
    const modules = [
      "financialData",
      "price",
      "summaryDetail",
      "defaultKeyStatistics",
      "assetProfile",
    ];
    const data = await yahooFinance.quoteSummary(
      symbol,
      { modules, validateResult: false },
      { fetchOptions: requestOptions }
    );
    if (data && data.price) {
      stockDataCache[symbol] = { data, timestamp: now };
      return data;
    }
  } catch (_) { /* silent — fall through */ }

  /* 2️⃣ fallback: light quote() call just for price/volume so UI never shows N/A */
  try {
    const q = await yahooFinance.quote(
      symbol,
      {
        fields: [
          "regularMarketPrice",
          "regularMarketVolume",
          "fiftyTwoWeekHigh",
          "fiftyTwoWeekLow",
          "regularMarketDayHigh",
          "regularMarketDayLow",
        ],
      },
      { fetchOptions: requestOptions }
    );
    if (q) {
      const data = { price: q };                 // wrap to mimic quoteSummary shape
      stockDataCache[symbol] = { data, timestamp: now };
      return data;
    }
  } catch (e) {
    console.error(`❌ Yahoo fetch ${symbol}:`, e.message);
  }
  return null;
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
async function buildForecastPrice(symbol, price){
  let adv = null;
  try {
    adv = await predictNextDay(symbol, await getWindowFromBucket(symbol));
  } catch(e){
    console.warn(`GRU failed for ${symbol}:`, e.message);
  }

  const simple = await simpleForecastPrice(symbol, price);
  const useAdvanced = adv !== null && Math.abs(adv - price) > 0.01;
  console.log(
    `Forecast for ${symbol}:`,
    useAdvanced ? `ADV(${adv.toFixed(2)})` : `SIMP(${simple.toFixed(2)})`
  );

  const final = useAdvanced ? adv : simple;
  forecastCache[symbol] = { price: final, timestamp: Date.now() };
  return final;
}

/*──────────────────────────────────────────
|  Rate‑limits                             |
└──────────────────────────────────────────*/
const stockCheckerLimiter = rateLimit({windowMs:60*1000,max:30,message:{message:"Too many requests, please try again shortly."}});
app.use("/api/check-stock", stockCheckerLimiter);

const findStockLimiter = rateLimit({windowMs:60*1000,max:30,message:{message:"Too many requests, please try again shortly."}});

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



app.get("/api/fundamentals/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const fund = await getFundamentals(symbol);
    if (!fund) throw new Error("No fundamentals returned");

    const stock = await fetchStockData(symbol);
    const currentPrice = stock?.price?.regularMarketPrice ?? null;

    // Valuation logic with PE → P/S fallback
    let valuation = null;
    let advice    = "";

    const { peRatio, priceToSales } = fund.ratios;
    const { peRatio: bmPE, priceToSales: bmPS } = fund.benchmarks;
    const cp = currentPrice;

    if (cp !== null && peRatio != null && bmPE != null && peRatio > 0) {
      const fairPrice = +((bmPE / peRatio) * cp).toFixed(2);
      const status    = fairPrice > cp ? "undervalued" : "overvalued";
      valuation       = { fairPrice, status };
      advice          = status === "undervalued"
        ? "Price below peer PE average—consider a closer look."
        : "Price above peer PE average—be cautious of overpaying.";
    }
    else if (cp !== null && priceToSales != null && bmPS != null && priceToSales > 0) {
      const fairPrice = +((bmPS / priceToSales) * cp).toFixed(2);
      const status    = fairPrice > cp ? "undervalued" : "overvalued";
      valuation       = { fairPrice, status };
      advice          = status === "undervalued"
        ? "Price below peer P/S average—consider a closer look."
        : "Price above peer P/S average—be cautious of overpaying.";
    }
    else {
      if (
        fund.weaknesses.some(w =>
          ["Negative net margin","Negative ROA"].includes(w.flag)
        )
      ) {
        advice = "Company is unprofitable—avoid investing.";
      } else {
        advice = "No valuation signal available.";
      }
    }

    return res.json({
      symbol,
      companyInfo: fund.companyInfo,
      ratios:      fund.ratios,
      benchmarks:  fund.benchmarks,
      rating:      fund.rating,
      weaknesses:  fund.weaknesses,
      valuation,
      advice,
      news:        fund.news,
      currentPrice,
      fetchedAt:   fund.fetchedAt,
    });
  } catch (err) {
    console.error("Fundamentals endpoint error:", err);
    return res.status(500).json({ message: "Failed to fetch fundamentals." });
  }
});



// GET /api/technical/:symbol
app.get('/api/technical/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const technical = await getTechnical(symbol);
    return res.json({ symbol, technical });
  } catch (err) {
    console.error('TechnicalService error:', err);
    return res.status(500).json({ error: err.message });
  }
});


/*──────────────────────────────────────────
|  12) STOCK CHECKER                       |
└──────────────────────────────────────────*/
app.post("/api/check-stock", async (req, res) => {
  try {
    let { symbol, intent, category = "overall" } = req.body || {};
    if (!symbol || !intent) {
      return res.status(400).json({ message: "symbol & intent required." });
    }
    const upper = String(symbol).toUpperCase();
    category = String(category).toLowerCase();

    // 1) Live quote / metrics
    const stock = await fetchStockData(upper);
    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }
    const priceData = stock.price;
    const summary   = stock.summaryDetail || {};
    const finData   = stock.financialData || {};

    const metrics = {
      volume:           priceData.regularMarketVolume ?? null,
      currentPrice:     priceData.regularMarketPrice  ?? null,
      peRatio:          summary.trailingPE            ?? null,
      pbRatio:          summary.priceToBook           ?? null,
      dividendYield:    summary.dividendYield         ?? null,
      earningsGrowth:   finData.earningsGrowth        ?? null,
      debtRatio:        finData.debtToEquity          ?? null,
      dayHigh:          priceData.regularMarketDayHigh?? null,
      dayLow:           priceData.regularMarketDayLow ?? null,
      fiftyTwoWeekHigh: summary.fiftyTwoWeekHigh      ?? null,
      fiftyTwoWeekLow:  summary.fiftyTwoWeekLow       ?? null,
    };

    // quick score (same idea you had)
    const avgVol = summary.averageDailyVolume3Month ?? metrics.volume ?? 0;
    let quickRating = 0;
    if (metrics.volume > avgVol * 1.2) quickRating += 3;
    else if (metrics.volume < avgVol * 0.8) quickRating -= 2;

    if (metrics.peRatio != null) {
      if (metrics.peRatio >= 5 && metrics.peRatio <= 25) quickRating += 2;
      else if (metrics.peRatio > 30) quickRating -= 1;
    }
    if (metrics.earningsGrowth != null) {
      if (metrics.earningsGrowth > 0.15) quickRating += 4;
      else if (metrics.earningsGrowth > 0.03) quickRating += 2;
      else if (metrics.earningsGrowth < 0) quickRating -= 2;
    }
    if (metrics.debtRatio != null) {
      if (metrics.debtRatio < 0.3) quickRating += 3;
      else if (metrics.debtRatio > 1) quickRating -= 1;
    }

    const dayRange  = (metrics.dayHigh  || 0) - (metrics.dayLow  || 0);
    const weekRange = (metrics.fiftyTwoWeekHigh || 0) - (metrics.fiftyTwoWeekLow || 0);
    if (dayRange > 0) {
      const pos = (metrics.currentPrice - metrics.dayLow) / dayRange;
      if (pos < 0.2) quickRating += 1;
      if (pos > 0.8) quickRating -= 1;
    }
    if (weekRange > 0) {
      const pos = (metrics.currentPrice - metrics.fiftyTwoWeekLow) / weekRange;
      if (pos < 0.3) quickRating += 2;
      if (pos > 0.8) quickRating -= 2;
    }

    // 2) Forecast (short horizon)
    const forecastPrice = await buildForecastPrice(upper, metrics.currentPrice);
    const growthPct = metrics.currentPrice
      ? ((forecastPrice - metrics.currentPrice) / metrics.currentPrice) * 100
      : 0;
    const classification =
      growthPct >= 2  ? "growth" :
      growthPct >= 0  ? "stable" : "unstable";

    // 3) News sentiment (used in overall, but cheap to keep)
    let news = { averageSentiment: 0, topStories: [] };
    try {
      const feed = await rssParser.parseURL(`https://news.google.com/rss/search?q=${upper}`);
      const items = (feed.items || []).slice(0, 5);
      const analyses = await Promise.all(
        items.map(async (item) => {
          let snippet = item.contentSnippet || item.title;
          try {
            const html = await (await fetchNative(item.link)).text();
            snippet = cheerio.load(html)("p").first().text() || snippet;
          } catch {}
          return {
            title: item.title,
            link:  item.link,
            snippet: snippet.slice(0, 200) + (snippet.length > 200 ? "…" : ""),
            sentiment: sentiment.analyze(snippet).score,
          };
        })
      );
      news = {
        averageSentiment: analyses.length
          ? analyses.reduce((s, a) => s + a.sentiment, 0) / analyses.length
          : 0,
        topStories: analyses,
      };
    } catch (_) {}

    // 4) Fundamental detail (only when requested or overall)
    let fundamentalDetail = null;
    if (category === "fundamental" || category === "overall") {
      try {
        const fund = await getFundamentals(upper);
        if (fund) {
          // keep your valuation fallback logic
          const { peRatio, priceToSales } = fund.ratios || {};
          const { peRatio: bmPE, priceToSales: bmPS } = fund.benchmarks || {};
          const cp = metrics.currentPrice;
          let valuation = fund.valuation ?? null;
          let advice = fund.advice ?? "";

          if (!valuation && cp != null) {
            if (peRatio != null && bmPE != null && peRatio > 0) {
              const fairPrice = +((bmPE / peRatio) * cp).toFixed(2);
              const status    = fairPrice > cp ? "undervalued" : "overvalued";
              valuation = { fairPrice, status };
              advice = status === "undervalued"
                ? "Price below peer PE average—consider a closer look."
                : "Price above peer PE average—be cautious of overpaying.";
            } else if (priceToSales != null && bmPS != null && priceToSales > 0) {
              const fairPrice = +((bmPS / priceToSales) * cp).toFixed(2);
              const status    = fairPrice > cp ? "undervalued" : "overvalued";
              valuation = { fairPrice, status };
              advice = status === "undervalued"
                ? "Price below peer P/S average—consider a closer look."
                : "Price above peer P/S average—be cautious of overpaying.";
            } else if (
              fund.weaknesses?.some(w =>
                ["Negative net margin","Negative ROA"].includes(w.flag)
              )
            ) {
              advice = "Company is unprofitable—avoid investing.";
            }
          }

          fundamentalDetail = {
            companyInfo: fund.companyInfo,
            ratios: fund.ratios,
            benchmarks: fund.benchmarks,
            rating: fund.rating,
            weaknesses: fund.weaknesses,
            valuation,
            advice,
            currentPrice: metrics.currentPrice,
            fetchedAt: fund.fetchedAt,
            news: fund.news
          };
        }
      } catch (e) {
        console.warn(`FundamentalsService failed for ${upper}:`, e.message);
      }
    }

    // 5) Technical detail (only when requested or overall)
    let technicalDetail = null;
    if (category === "technical" || category === "overall") {
      try {
        const userId = req.user?.userId || req.headers['x-user-id'] || null; // header fallback if route stays public
        const t = await getTechnicalForUser(upper, userId);
        technicalDetail = {
          rsi14:  t?.indicators?.RSI14 ?? null,
          macd:   t?.indicators?.MACD ?? null,
          sma50:  t?.indicators?.SMA50 ?? null,
          sma200: t?.indicators?.SMA200 ?? null,
          atr14:  t?.indicators?.ATR14 ?? null,
          trend:  t?.trend ?? (() => {
            const s50 = t?.indicators?.SMA50, s200 = t?.indicators?.SMA200;
            if (s50 && s200) return s50 > s200 ? 'uptrend' : (s50 < s200 ? 'downtrend' : 'sideways');
            return 'sideways';
          })(),
          levels: t?.levels ?? {
            support: metrics.dayLow ?? metrics.fiftyTwoWeekLow,
            resistance: metrics.dayHigh ?? metrics.fiftyTwoWeekHigh,
          },
          suggestion: t?.suggestion,        // <-- action/entry/stop/target/why
          instructions: t?.instructions,    // <-- human-readable steps
          raw: t                            // <-- includes chartUrl & the full series
      };

      } catch (e) {
        console.warn(`TechnicalService failed for ${upper}:`, e.message);
      }
    }

    // 6) Build the base payload
    const base = {
      symbol: upper,
      name:   priceData.longName || upper,
      industry: stock.assetProfile?.industry || "Unknown",
      metrics
    };

    if (category === "fundamental") {
      return res.json({ ...base, fundamentals: fundamentalDetail });
    }
    if (category === "technical") {
      return res.json({ ...base, technical: technicalDetail });
    }

    // overall summary
    const combinedScore = +(0.2 * quickRating + 0.8 * growthPct).toFixed(2);
    const advice =
      classification === "growth" ? "Projected to grow. Consider buying." :
      classification === "stable" ? "Minimal growth expected. Hold or monitor." :
                                    "Projected to decline. Consider selling or avoiding.";

    return res.json({
      ...base,
      fundamentalRating: quickRating.toFixed(2),
      combinedScore,
      classification,
      advice,
      forecast: {
        forecastPrice: +forecastPrice.toFixed(2),
        projectedGrowthPercent: `${growthPct.toFixed(2)}%`,
        forecastPeriod: "Close",
        forecastEndDate: getForecastEndTime(),
      },
      fundamentals: fundamentalDetail || {},
      technical: technicalDetail || {},
      news
    });
  } catch (err) {
    console.error("check-stock:", err);
    return res.status(500).json({ message: "Server error." });
  }
});
/*──────────────────────────────────────────
|  STOCK‑HISTORY  –  daily candles         |
└──────────────────────────────────────────*/
app.post("/api/stock-history*", async (req, res) => {
  try {
    const { symbol, range = "1m" } = req.body || {};
    if (!symbol) return res.status(400).json({ message: "symbol required." });

    const dayCount = {
      "1d": 1,  "5d": 5,  "1w": 7,
      "1m": 30, "6m": 180, "1y": 365, "MAX": 1825
    }[range] ?? 30;

    const end = new Date();
    const start = new Date(end.getTime() - dayCount * 24 * 60 * 60 * 1000);

    const rows = await yahooFinance.historical(
      symbol,
      { period1: start, period2: end, interval: "1d" },
      { fetchOptions: requestOptions }
    );

    if (!rows || !rows.length) return res.json({ data: [] });

    rows.sort((a, b) => new Date(a.date) - new Date(b.date));
    const data = rows.map(r => ({
      date:  r.date,
      open:  r.open,  high: r.high,
      low:   r.low,   close:r.close,
      volume:r.volume
    }));

    return res.json({ symbol, range, data });
  } catch (e) {
    console.error("stock-history:", e.message);
    return res.status(500).json({ data: [] });
  }
});


// ────────────────────────────────────────────────────────────
// Intraday Indicators Endpoint
// ────────────────────────────────────────────────────────────



app.get("/api/intraday/:symbol", async (req, res) => {
  try {
    const symbol = (req.params.symbol || "").toUpperCase();
    const opts = {
      interval: req.query.interval, // e.g. '1m'
      range: req.query.range,       // e.g. '1d'
      from: req.query.from,         // ISO timestamp (optional)
      to: req.query.to,             // ISO timestamp (optional)
    };
    const data = await getIntradayIndicators(symbol, opts);
    res.json(data);
  } catch (err) {
    console.error(`intraday/${req.params.symbol}:`, err);
    res.status(500).json({ error: err.message });
  }
});


/*──────────────────────────────────────────
|  13) FINDER (batched / rate‑limited)     |
└──────────────────────────────────────────*/
// -------- Finder (optimized) --------
const finderRouter = express.Router();


async function classifyStockByForecast(sym) {
  const q = await fetchStockData(sym).catch(() => null);
  const price = q?.price?.regularMarketPrice;
  if (!price) return { classification: 'unknown', growthPct: 0, forecastPrice: null };

  const fc = await buildForecastPrice(sym, price);
  const growthPct = ((fc - price) / price) * 100;
  const classification = growthPct >= 2 ? 'growth' : (growthPct >= 0 ? 'stable' : 'unstable');
  return { classification, growthPct, forecastPrice: fc };
}



// apply limiter to just this route
finderRouter.use("/api/find-stocks", findStockLimiter);

/* helper – fetch quotes in parallel, max N at once */
async function fetchBatch(symbols, maxParallel = 20) {
  const out = [];
  let active = [];
  for (const sym of symbols) {
    active.push(
      fetchStockData(sym).then((d) => ({ sym, data: d })).catch(() => null)
    );
    if (active.length >= maxParallel) {
      out.push(...(await Promise.all(active)));
      active = [];
    }
  }
  if (active.length) out.push(...(await Promise.all(active)));
  return out.filter(Boolean);
}

finderRouter.post("/api/find-stocks", async (req, res) => {
  try {
    let { stockType, exchange, minPrice, maxPrice, limit = 400 } = req.body;
    if (
      typeof stockType !== "string" ||
      typeof exchange !== "string" ||
      typeof minPrice !== "number" ||
      typeof maxPrice !== "number"
    ) {
      return res.status(400).json({ message: "Bad finder parameters." });
    }
    stockType = stockType.toLowerCase();
    exchange = exchange.toUpperCase();

    // 1) Universe by exchange, capped by limit
    const tickers = symbolsList
      .filter((s) => {
        const ex = (typeof s === "string" ? "N/A" : s.exchange || "N/A").toUpperCase();
        return ex === exchange;
      })
      .map((s) => (typeof s === "string" ? s : s.symbol))
      .slice(0, limit);

    // 2) Prices in bulk, pre-filter by price range
    const batchResults = await fetchBatch(tickers, 20);
    const inRange = batchResults
      .filter(({ data }) => {
        const price = data?.price?.regularMarketPrice;
        return price && price >= minPrice && price <= maxPrice;
      })
      .map(({ sym }) => sym);

    // 3) Classify only survivors, in parallel
    const classifications = await Promise.all(
      inRange.map(async (sym) => {
        const { classification } = await classifyStockByForecast(sym);
        return { sym, classification };
      })
    );

    // 4) Final list
    const stocks = classifications
      .filter(({ classification }) => classification === stockType)
      .map(({ sym }) => ({ symbol: sym, exchange }));

    return res.json({ stocks });
  } catch (err) {
    console.error("Finder error:", err);
    return res.status(500).json({ message: "Finder server error." });
  }
});

app.use("/finder", finderRouter);


/*──────────────────────────────────────────
|  14) Dashboard helper endpoints          |
└──────────────────────────────────────────*/

/* utility: split an array into chunks */
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* 1️⃣  MOST‑TRADED POPULAR STOCKS  */
app.get("/api/popular-stocks*", async (_req, res) => {
  try {
    const popular = ["AAPL", "TSLA", "AMZN", "NVDA", "META", "GOOG", "MSFT"];
    const quotes = await Promise.all(
      popular.map((s) => fetchStockData(s).catch(() => null))
    );

    const rows = quotes
      .map((d, i) =>
        d && d.price
          ? {
              symbol: popular[i],
              name: d.price.longName || popular[i],
              price: d.price.regularMarketPrice || 0,
              volume: d.price.regularMarketVolume || 0,
            }
          : null
      )
      .filter(Boolean);

    return res.json({ stocks: rows });
  } catch (e) {
    console.error("popular-stocks:", e.message);
    return res.status(500).json({ stocks: [] });
  }
});

/* 2️⃣  TOP‑FORECASTED (first 200 tickers, batched) */
app.get("/api/top-forecasted*", async (_req, res) => {
  try {
    const sample = symbolsList
      .slice(0, 200)
      .map((s) => (typeof s === "string" ? s : s.symbol));

    const gains = [];
    for (const group of chunk(sample, 10)) {
      const results = await Promise.all(
        group.map(async (sym) => {
          const q = await fetchStockData(sym).catch(() => null);
          const price = q?.price?.regularMarketPrice;
          if (!price) return null;
          const fc = await buildForecastPrice(sym, price);
          return { symbol: sym, gain: ((fc - price) / price) * 100 };
        })
      );
      gains.push(...results.filter(Boolean));
    }

    gains.sort((a, b) => b.gain - a.gain);
    return res.json({ forecasts: gains.slice(0, 5) });
  } catch (e) {
    console.error("top‑forecasted:", e.message);
    return res.status(500).json({ forecasts: [] });
  }
});

/* 3️⃣  TOP NEWS HEADLINES */
app.get("/api/top-news*", async (_req, res) => {
  try {
    const feed = await rssParser.parseURL(
      "https://news.google.com/rss/search?q=stock+market"
    );
    const headlines = (feed.items || []).slice(0, 5).map((i) => ({
      title: i.title,
      url: i.link,
    }));
    return res.json({ headlines });
  } catch (e) {
    console.error("top‑news:", e.message);
    return res.status(500).json({ headlines: [] });
  }
});

/* 4️⃣  NOTIFICATIONS placeholder (keeps dashboard happy) */
app.get("/api/notifications*", (_req, res) => {
  res.json({ notifications: [] });
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
    text: `Reset link (valid 1 h): https://sci-investments.web.app/resetPassword.html?token=${token}`,
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


// ────────────────────────────────────────────────────────────
// 18-C) Daily fundamentals refresh at 2:00 AM ET, weekdays
// ────────────────────────────────────────────────────────────
const cron = require('node-cron');

// Build a watchlist — prefer portfolio if present, with a small fallback
const watchlist = Array.from(new Set(
  (portfolio || []).map(p => p.symbol).filter(Boolean).concat(['AAPL','MSFT','NVDA'])
));

// Use your existing FundamentalsService to warm cache / refresh
async function pullCompanyFundamentals(symbol) {
  try {
    await getFundamentals(symbol);
    console.log(`✅ Refreshed fundamentals for ${symbol}`);
  } catch (err) {
    console.error(`❌ pullCompanyFundamentals(${symbol}):`, err.message);
  }
}

cron.schedule('0 2 * * 1-5', () => {
  console.log('⏰ Running daily pullCompanyFundamentals…');
  watchlist.forEach(sym => pullCompanyFundamentals(sym));
}, { timezone: 'America/New_York' });


/*──────────────────────────────────────────
|  Start server                            |
└──────────────────────────────────────────*/
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Combined server running on port ${PORT}`));
/*******************************************
 * COMBINED SERVER FOR AUTH, STOCK CHECKER,
 * FINDER, DASHBOARD, FORECASTING, COMMUNITY
 *******************************************/

const path       = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const bcrypt     = require('bcryptjs');
const admin      = require('firebase-admin');
const mongoose   = require('mongoose');
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
const pdfParse  = require('pdf-parse');
const chokidar  = require('chokidar');
const RESEARCH_DIR = path.join(__dirname, '..', 'research'); // your folder outside backend

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


// ---- Express app ----
const app = express();
app.use(express.json());

// ─── CORS (single global config, hardened) ─────────────────────────────────────
app.set('trust proxy', 1); // required behind Render's proxy

const ALLOWLIST = new Set([
  'https://sci-investments.web.app',
  'https://sci-investments.firebaseapp.com',  // add Firebase's legacy host too
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]);

// add Vary: Origin so caches don't poison responses
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

const corsOptionsDelegate = (req, cb) => {
  const origin = req.headers.origin;
  const allowed = !origin || ALLOWLIST.has(origin);
  cb(null, {
    origin: allowed ? origin : false,     // echo the exact allowed origin
    credentials: true,
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','Accept','x-user-id'],
    optionsSuccessStatus: 204,
  });
};

app.use(cors(corsOptionsDelegate));

// Catch-all preflight handler. Keeps headers even if route/middleware throws.
app.options('*', (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWLIST.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,x-user-id');
  }
  res.sendStatus(204);
});

app.use(express.static(path.join(__dirname, "../public")));



const newsletterRouter = require('./routes/newsletter');
app.use('/api/newsletter', newsletterRouter);

// Best-buys cache (10 min)
const BEST_BUYS_CACHE = { ts: 0, data: null };
const BEST_BUYS_TTL_MS = 10 * 60 * 1000;


// simple timeout wrapper for any promise
function withTimeout(promise, ms = 4000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}





// ─── INDEXER ─────────────────────────────────────────────────────────────
const researchIndex = new Map(); // key: SYMBOL -> { docs:[{title, date, text, path}], mergedText }
function guessSymbolFromFilename(file) {
  const base = path.basename(file).replace(/\.[Pp][Dd][Ff]$/, '');
  // Accept patterns like "TSLA - Q2 Review.pdf", "Research_TSLA_2024.pdf", etc.
  const hit = base.toUpperCase().match(/\b[A-Z]{1,5}\b/);
  return hit ? hit[0] : null;
}

async function loadResearchFolder() {
  if (!fs.existsSync(RESEARCH_DIR)) return;
  const files = fs.readdirSync(RESEARCH_DIR).filter(f => /\.pdf$/i.test(f));
  for (const f of files) {
    const full = path.join(RESEARCH_DIR, f);
    const data = await pdfParse(fs.readFileSync(full)).catch(() => null);
    if (!data || !data.text) continue;
    const sym = guessSymbolFromFilename(f);
    if (!sym) continue;
    const entry = researchIndex.get(sym) || { docs: [], mergedText: '' };
    entry.docs.push({
      title: f.replace(/\.pdf$/i, ''),
      date: fs.statSync(full).mtime.toISOString().slice(0,10),
      text: data.text.slice(0, 200000), // cap to keep prompt sane
      path: full
    });
    entry.mergedText = (entry.mergedText + '\n\n' + data.text).slice(-500000); // keep last 500k chars
    researchIndex.set(sym, entry);
  }
  console.log(`📚 Research loaded for: ${Array.from(researchIndex.keys()).join(', ') || '(none)'}`);
}

// initial load + watch for changes
loadResearchFolder().catch(e => console.warn('research load:', e.message));
if (fs.existsSync(RESEARCH_DIR)) {
  chokidar.watch(RESEARCH_DIR, { ignoreInitial: true })
    .on('add', () => loadResearchFolder())
    .on('change', () => loadResearchFolder())
    .on('unlink', () => loadResearchFolder());
}

// ────── ACCESSOR ─────────────────────────────────────────────────────────────────────

function getResearchForSymbol(symbol) {
  const e = researchIndex.get(String(symbol || '').toUpperCase());
  if (!e) return null;
  // keep a short “context pack” for the LLM
  const docs = e.docs.slice(-3); // most recent 3
  const joined = docs.map(d => `■ ${d.title} (${d.date})\n${d.text}`).join('\n\n---\n\n');
  // trim again (LLM safety)
  return joined.slice(0, 120000); // ~120k chars max (you can lower)
}


// ─── CHAT ─────────────────────────────────────────────────────────────

// ==== CHAT SERVICE ADAPTER ====
const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || 'https://chatai-yfo4ujklgq-uc.a.run.app';

function renderPromptFromMessages(system, messages) {
  const turns = (messages || [])
    .map(m => `${(m.role || 'user').toUpperCase()}: ${m.content || ''}`)
    .join('\n');
  return `${system}\n\n--- DIALOGUE ---\n${turns}`.trim();
}

function normalizeChatResponse(data) {
  const text =
    data?.text ??
    data?.output ??
    data?.reply ??
    data?.choices?.[0]?.message?.content ??
    (typeof data === 'string' ? data : '');
  return String(text || '').trim();
}

// ==== CHAT SERVICE ADAPTER (hardened) ====
function trimMessages(messages = [], maxTurns = 12, maxCharsPerMsg = 1500) {
  const out = [];
  for (const m of [...messages].reverse()) {
    out.unshift({
      role: m.role || 'user',
      content: String(m.content || '').slice(-maxCharsPerMsg)
    });
    if (out.length >= maxTurns) break;
  }
  return out;
}

async function callChatServiceAdaptive({ system, messages }) {
  if (!CHAT_SERVICE_URL) return ''; // let caller fall back

  const safeMsgs = trimMessages(messages || [], 12, 1500);
  const safeSystem = String(system || '').slice(0, 8000); // protect token budget
  const packed = [{ role: 'system', content: safeSystem }, ...safeMsgs];

  const opts = { timeout: 20000 }; // 20s hard cap

  // A) messages-based call
  try {
    const rA = await axios.post(CHAT_SERVICE_URL, { messages: packed }, opts);
    const tA = normalizeChatResponse(rA.data);
    if (tA) return tA;
    console.warn('Chat A empty. keys=', Object.keys(rA.data || {}));
  } catch (e) {
    console.warn('Chat A error:', e.message);
  }

  // B) single-prompt fallback
  try {
    const prompt = renderPromptFromMessages(safeSystem, safeMsgs);
    const rB = await axios.post(CHAT_SERVICE_URL, { prompt }, opts);
    const tB = normalizeChatResponse(rB.data);
    if (tB) return tB;
    console.warn('Chat B empty. keys=', Object.keys(rB.data || {}));
  } catch (e) {
    console.warn('Chat B error:', e.message);
  }

  return ''; // important: don't throw → caller can build an offline reply
}


// ultra-light quote: price/vol/day/52w only
async function getLightQuote(symbol) {
  try {
    const q = await withTimeout(
      yahooFinance.quote(
        symbol,
        {
          fields: [
            "regularMarketPrice",
            "regularMarketVolume",
            "regularMarketDayHigh",
            "regularMarketDayLow",
            "fiftyTwoWeekHigh",
            "fiftyTwoWeekLow",
          ],
        },
        { fetchOptions: requestOptions }
      ),
      6000
    );
    return q || null;
  } catch { return null; }
}



// ─── BODY PARSER ───────────────────────────────────────────────────────────────
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));


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


// ─── BIG BRAIN ────────────────────────────────────────────────────────

// server.js (add near other helpers)
async function buildResearchPack(symbol) {
  const y = await fetchStockData(symbol);

  // --- reuse Stock-Checker / Finder metrics ---
  const priceData = y?.price || {};
  const summary   = y?.summaryDetail || {};
  const finData   = y?.financialData || {};
  const researchText = getResearchForSymbol(symbol);


  const checkerMetrics = {
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
    avgVol:           summary.averageDailyVolume3Month ?? priceData.regularMarketVolume ?? 0,
  };

  // quickRating (same rules as /api/check-stock)
  let quickRating = 0;
  if (checkerMetrics.volume > checkerMetrics.avgVol * 1.2) quickRating += 3;
  else if (checkerMetrics.volume < checkerMetrics.avgVol * 0.8) quickRating -= 2;

  if (checkerMetrics.peRatio != null) {
    if (checkerMetrics.peRatio >= 5 && checkerMetrics.peRatio <= 25) quickRating += 2;
    else if (checkerMetrics.peRatio > 30) quickRating -= 1;
  }
  if (checkerMetrics.earningsGrowth != null) {
    if (checkerMetrics.earningsGrowth > 0.15) quickRating += 4;
    else if (checkerMetrics.earningsGrowth > 0.03) quickRating += 2;
    else if (checkerMetrics.earningsGrowth < 0) quickRating -= 2;
  }
  if (checkerMetrics.debtRatio != null) {
    if (checkerMetrics.debtRatio < 0.3) quickRating += 3;
    else if (checkerMetrics.debtRatio > 1) quickRating -= 1;
  }

  // Finder-style quality score (compact)
  function computeFinderScore(f) {
    let score = 0; const reasons = [];
    if (f.avgVol >= 1_000_000) { score += 4; reasons.push("Good liquidity"); }
    else if (f.avgVol >= 250_000) { score += 2; reasons.push("OK liquidity"); }
    else reasons.push("Thinly traded");

    if (f.pe && f.pe > 4 && f.pe < 30) { score += 3; reasons.push("Reasonable PE"); }
    else if (f.ps && f.ps < 8) { score += 1; reasons.push("P/S acceptable"); }
    else { score -= 1; reasons.push("Valuation rich/unknown"); }

    if (typeof f.growth === "number") {
      if (f.growth > 0.15) { score += 4; reasons.push("Strong earnings growth"); }
      else if (f.growth > 0.03) { score += 2; reasons.push("Modest earnings growth"); }
      else if (f.growth < 0) { score -= 2; reasons.push("Negative earnings growth"); }
    }
    if (typeof f.debtToEq === "number") {
      if (f.debtToEq < 0.6) { score += 3; reasons.push("Low leverage"); }
      else if (f.debtToEq > 1.5) { score -= 2; reasons.push("High leverage"); }
    }

    if (f.wkHi && f.wkLo && f.price && f.wkHi > f.wkLo) {
      const pos = (f.price - f.wkLo) / (f.wkHi - f.wkLo);
      if (pos < 0.3) { score += 2; reasons.push("Near 52w lows"); }
      else if (pos > 0.9) { score -= 1; reasons.push("Near 52w highs"); }
    }
    return { score, reasons };
  }

  const finderFeatures = {
    price: checkerMetrics.currentPrice,
    avgVol: checkerMetrics.avgVol,
    pe: summary.trailingPE ?? null,
    ps: summary.priceToSalesTrailing12Months ?? null,
    pb: summary.priceToBook ?? null,
    div: summary.dividendYield ?? null,
    wkHi: checkerMetrics.fiftyTwoWeekHigh,
    wkLo: checkerMetrics.fiftyTwoWeekLow,
    dayHi: checkerMetrics.dayHigh,
    dayLo: checkerMetrics.dayLow,
    growth: checkerMetrics.earningsGrowth,
    debtToEq: checkerMetrics.debtRatio,
    grossMargin: finData.grossMargins ?? null,
    opMargin: finData.operatingMargins ?? null,
  };
  const { score: finderScore, reasons: finderReasons } = computeFinderScore(finderFeatures);

  // Fundamentals / technical / short term
  const fundamentals = await getFundamentals(symbol).catch(() => null);
  const technical    = await getTechnicalForUser(symbol, null).catch(() => null);
  const st           = await computeShortTermExpectedMove(symbol).catch(() => null);

  // live snapshot
  const live = {
    name: y?.price?.longName || symbol,
    price: checkerMetrics.currentPrice ?? null,
    dayHigh: checkerMetrics.dayHigh ?? null,
    dayLow:  checkerMetrics.dayLow  ?? null,
    wkHigh:  checkerMetrics.fiftyTwoWeekHigh ?? null,
    wkLow:   checkerMetrics.fiftyTwoWeekLow  ?? null
  };

  const pos52w = (live.price!=null && live.wkHigh && live.wkLow && live.wkHigh>live.wkLow)
    ? ((live.price - live.wkLow)/(live.wkHigh - live.wkLow))
    : null;

  const ratios = fundamentals?.ratios || {};
  const bench  = fundamentals?.benchmarks || {};
  const valuation = fundamentals?.valuation ?? null;

  const tech = technical ? {
    trend: technical.trend ?? null,
    levels: technical.levels ?? null,
    indicators: {
      RSI14:  technical?.indicators?.RSI14 ?? null,
      MACD:   technical?.indicators?.MACD ?? null,
      SMA50:  technical?.indicators?.SMA50 ?? null,
      SMA200: technical?.indicators?.SMA200 ?? null,
      ATR14:  technical?.indicators?.ATR14 ?? null,
    },
    suggestion: technical.suggestion ?? null,
    instructions: technical.instructions ?? null
  } : null;

  const stCompact = st ? {
    pUpPct: +(st.pUp * 100).toFixed(1),
    magnitudePct: +(st.magnitude * 100).toFixed(2),
    expectedReturnPct: +(st.expectedReturn * 100).toFixed(2)
  } : null;

  // light news
  let news = [];
  try {
    const feed = await rssParser.parseURL(`https://news.google.com/rss/search?q=${symbol}`);
    news = (feed.items || []).slice(0, 5).map(i => ({ title: i.title, url: i.link }));
  } catch {}

  // ---------- FINAL RETURN ----------
  return {
    symbol,
    live,
    pos52w,
    metrics: { ...checkerMetrics, quickRating },
    finder: { score: finderScore, reasons: finderReasons },

    fundamentals: {
      rating: fundamentals?.rating ?? null,
      weaknesses: fundamentals?.weaknesses ?? [],
      ratios: {
        pe: ratios.peRatio ?? null,
        ps: ratios.priceToSales ?? null,
        pb: ratios.priceToBook ?? null,
        debtToEq: ratios.debtToEquity ?? null,
        earningsGrowth: ratios.earningsGrowth ?? null,
      },
      benchmarks: {
        pe: bench.peRatio ?? null,
        ps: bench.priceToSales ?? null,
      },
      valuation, // { fairPrice, status }
    },

    technical: tech,
    shortTerm: stCompact,
    news,
    research: researchText ? { note: "From local research PDFs", text: researchText } : null
  };
}


const ChatMemory = require('./models/ChatMemory');

// --- Helper: get user profile from auth header or x-user-id ---
async function getUserProfile(req) {
  try {
    let userId = null;
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      const idToken = header.split(' ')[1];
      const decoded = await admin.auth().verifyIdToken(idToken);
      userId = decoded.uid;
    } else if (req.headers['x-user-id']) {
      userId = req.headers['x-user-id'];
    }
    if (!userId) return null;
    return await UserProfile.findOne({ userId }).lean();
  } catch (e) {
    console.warn('getUserProfile:', e.message);
    return null;
  }
}

// --- Helper: call your CF to personalize the advice ---
async function buildAdvisorSuggestion({ symbol, profile, baseAdvice, fundamentals, technical, metrics }) {
  try {
    const cfUrl =
      process.env.NODE_ENV === "production"
        ? "https://us-central1-sci-investments.cloudfunctions.net/onboardAI"
        : "http://127.0.0.1:5001/sci-investments/us-central1/onboardAI";

    const techNorm = technical ? {
      trend:  technical.trend ?? null,
      levels: technical.levels ?? null,
      rsi14:  technical.indicators?.RSI14 ?? technical.rsi14 ?? null,
      macd:   technical.indicators?.MACD  ?? technical.macd  ?? null,
    } : null;
    
    const prompt = `
You are an AI financial advisor. Personalize the recommendation for the user below.
Return a concise paragraph (<=120 words) that starts with "Advisor Suggestion:".

User profile (JSON): ${JSON.stringify(profile || {}, null, 2)}
Symbol: ${symbol}
Metrics: ${JSON.stringify(metrics || {})}
Fundamentals: ${JSON.stringify(fundamentals ? {
  valuation: fundamentals.valuation, rating: fundamentals.rating, weaknesses: fundamentals.weaknesses
} : {})}
Technical: ${JSON.stringify(techNorm || {})}
Raw system advice: ${baseAdvice || "N/A"}

If the raw advice conflicts with the user's risk tolerance, horizon, diversification, or sector preferences, say so and adjust the action (e.g., smaller position, hold, avoid) with 1–2 concrete reasons tied to the profile.
    `.trim();

    const resp = await axios.post(cfUrl, { symbol, prompt });
    const text = (resp.data && (resp.data.text || resp.data)) || "";
    return String(text).trim();
  } catch (e) {
    console.warn("Advisor CF error:", e.message);
    return null;
  }
}



// ─── AI Advisor Picks (personalized from chat memory) ─────────────────────────
// ─── AI Advisor Picks (from chats + for-you discovery) ───────────────────────
app.get('/api/ai-picks', authenticate, async (req, res) => {
  try {
    const userId  = req.user.userId;
    const profile = await getUserProfile(req).catch(() => null);
    const mem     = await ChatMemory.findOne({ userId }).lean().catch(() => null);

    /* ---------- A) From your chats (watchlist) ---------- */
    const watch = Array.from(
      new Set((mem?.facts?.watchlist || []).map(s => String(s).toUpperCase()))
    ).slice(0, 12); // small cap for work

    const fromChats = [];
    for (const sym of watch) {
      try {
        const q     = await fetchStockData(sym).catch(() => null);
        const price = q?.price?.regularMarketPrice;
        if (!price) continue;

        const st = await computeShortTermExpectedMove(sym).catch(() => null);
        if (!st) continue;

        const row = {
          symbol: sym,
          price,
          pUp: +(st.pUp * 100).toFixed(1),
          magnitudePct: +(st.magnitude * 100).toFixed(2),
          expectedReturnPct: +(st.expectedReturn * 100).toFixed(2)
        };

        const baseAdvice =
          row.expectedReturnPct >= 0
            ? `Projected next-day return ~${row.expectedReturnPct}%.`
            : `Risk of decline ~${Math.abs(row.expectedReturnPct)}%.`;

        try {
          const suggestion = await buildAdvisorSuggestion({
            symbol: sym,
            profile,
            baseAdvice,
            fundamentals: null,
            technical: null,
            metrics: {
              currentPrice: price,
              pUp: row.pUp,
              expectedReturnPct: row.expectedReturnPct
            }
          });
          if (suggestion) row.advisorSuggestion = String(suggestion).trim();
        } catch {}

        fromChats.push(row);
      } catch {}
    }
    fromChats.sort((a, b) =>
      (b.expectedReturnPct - a.expectedReturnPct) || (b.pUp - a.pUp)
    );

    /* ---------- B) For You (discovery, personalized) ---------- */
    // preferences
    const risk     = String(profile?.riskTolerance || 'medium').toLowerCase();
    const horizon  = String(profile?.horizon || 'short').toLowerCase();
    const sectors  = Array.isArray(profile?.sectors) ? profile.sectors.map(String) : [];

    const minPrice = risk === 'low' ? 10 : risk === 'medium' ? 5 : 2;
    const maxPrice = risk === 'low' ? 300 : risk === 'medium' ? 250 : 400;

    // small universe to keep it snappy (raise later if you like)
    const UNIVERSE = 220;
    const universe = symbolsList
      .slice(0, UNIVERSE)
      .map(s => (typeof s === 'string' ? s : s.symbol));

    const forYou = [];
    for (const sym of universe) {
      try {
        const yq = await fetchStockData(sym).catch(() => null);
        const p  = yq?.price?.regularMarketPrice;
        if (!p || p < minPrice || p > maxPrice) continue;

        // optional sector bias bonus
        const sec = yq?.assetProfile?.sector || '';
        const sectorBonus = sectors.length
          ? (sectors.some(s => (sec || '').toLowerCase().includes(String(s).toLowerCase())) ? 1 : 0)
          : 0;

        // short-term model (T+1). If you prefer long-term, swap in buildForecastPrice()
        const st = await computeShortTermExpectedMove(sym).catch(() => null);
        if (!st) continue;

        const row = {
          symbol: sym,
          price: p,
          pUp: +(st.pUp * 100).toFixed(1),
          magnitudePct: +(st.magnitude * 100).toFixed(2),
          expectedReturnPct: +(st.expectedReturn * 100).toFixed(2),
          _rank: st.expectedReturn + 0.002 * sectorBonus // small nudge for sector prefs
        };

        // quick, lightweight personalization snippet
        const baseAdvice =
          row.expectedReturnPct >= 0
            ? `Projected next-day return ~${row.expectedReturnPct}% (p_up ${row.pUp}%).`
            : `Expected softness (~${Math.abs(row.expectedReturnPct)}%).`;

        try {
          const suggestion = await buildAdvisorSuggestion({
            symbol: sym,
            profile,
            baseAdvice,
            fundamentals: null,
            technical: null,
            metrics: {
              currentPrice: p,
              pUp: row.pUp,
              expectedReturnPct: row.expectedReturnPct,
              horizon
            }
          });
          if (suggestion) row.advisorSuggestion = String(suggestion).trim();
        } catch {}

        forYou.push(row);
      } catch {}
    }

    forYou.sort((a, b) =>
      (b._rank - a._rank) || (b.expectedReturnPct - a.expectedReturnPct) || (b.pUp - a.pUp)
    );

    return res.json({
      picksFromChats: fromChats.slice(0, 5),
      picksForYou: forYou.slice(0, 5),
      meta: { horizon, risk, sectors, minPrice, maxPrice }
    });
  } catch (e) {
    console.error('ai-picks:', e.message);
    res.status(500).json({ picksFromChats: [], picksForYou: [] });
  }
});




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
|  Symbol validator (used by multiple routes)
└──────────────────────────────────────────*/
function isValidSymbol(s) {
  if (!s) return false;
  const sym = String(s).trim().toUpperCase();

  // Keep the pattern conservative; expand if you store dots/hyphens in symbols.json
  if (!/^[A-Z]{1,5}$/.test(sym)) return false;

  // Check against your symbols.json
  return symbolsList.some(x => (typeof x === 'string' ? x : x.symbol) === sym);
}


/*──────────────────────────────────────────
|  Rate‑limits                             |
└──────────────────────────────────────────*/
const stockCheckerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',   // <-- key
});
app.use("/api/check-stock", stockCheckerLimiter);

const findStockLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

/*──────────────────────────────────────────
|  ===  REST ENDPOINTS (all original)  === |
└──────────────────────────────────────────*/

/*──────────────────────────────────────────
|  11) Auth Endpoints                      |
└──────────────────────────────────────────*/
app.get("/", (_req, res) => res.send("✅ Combined Server is running!"));
// Lightweight health check for the dashboard warm-up
app.get("/api/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    uptime: process.uptime(),
    now: new Date().toISOString(),
  });
});


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
  const symbol = (req.params.symbol || "").toUpperCase();
  try {
    const fund = await getFundamentals(symbol);
    if (!fund) throw new Error("No fundamentals returned");

    const stock = await fetchStockData(symbol).catch(() => null);
    const currentPrice = stock?.price?.regularMarketPrice ?? null;

    // Start with any valuation/advice the service already computed
    let valuation = fund.valuation ?? null;
    let advice    = fund.advice ?? "";

    // Safe destructuring (guards when service omits sections)
    const { peRatio, priceToSales, priceToBook } = fund.ratios || {};
    const {
      peRatio: bmPE,
      priceToSales: bmPS,
      priceToBook: bmPB
    } = fund.benchmarks || {};
    const cp = currentPrice;

    // Helper to set valuation/advice consistently
    function setValuation(fairPriceCalc, basisLabel) {
      const fair = +(fairPriceCalc).toFixed(2);
      const status = fair > cp ? "undervalued" : "overvalued";
      valuation = { fairPrice: fair, status };
      advice =
        status === "undervalued"
          ? `Price below peer ${basisLabel} average—consider a closer look.`
          : `Price above peer ${basisLabel} average—be cautious of overpaying.`;
    }

    // Only compute if we don't already have a valuation and we have a live price
    if (valuation == null && Number.isFinite(cp)) {
      if (peRatio != null && peRatio > 0 && bmPE != null && bmPE > 0) {
        setValuation((bmPE / peRatio) * cp, "PE");
      } else if (priceToSales != null && priceToSales > 0 && bmPS != null && bmPS > 0) {
        setValuation((bmPS / priceToSales) * cp, "P/S");
      } else if (priceToBook != null && priceToBook > 0 && bmPB != null && bmPB > 0) {
        setValuation((bmPB / priceToBook) * cp, "P/B");
      } else {
        if (
          Array.isArray(fund.weaknesses) &&
          fund.weaknesses.some(w => ["Negative net margin", "Negative ROA"].includes(w.flag))
        ) {
          advice = "Company is unprofitable—avoid investing.";
        } else {
          advice = advice || "No valuation signal available.";
        }
      }
    }

    return res.json({
      symbol,
      companyInfo: fund.companyInfo || null,
      ratios:      fund.ratios || {},
      benchmarks:  fund.benchmarks || {},
      rating:      fund.rating ?? null,
      weaknesses:  fund.weaknesses || [],
      valuation,
      advice,
      news:        fund.news || [],
      currentPrice: cp,
      fetchedAt:   fund.fetchedAt || new Date().toISOString(),
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
    // 2) Forecast (short horizon — expected move model)
    let forecastPrice = metrics.currentPrice;
    let growthPct = 0;
    try {
      const st = await withTimeout(computeShortTermExpectedMove(upper), 4000);
      if (st && metrics.currentPrice) {
        const expR = st.expectedReturn;                 // signed decimal
        forecastPrice = +(metrics.currentPrice * (1 + expR));
        growthPct = expR * 100;
      } else if (metrics.currentPrice) {
        try {
          const fc = await withTimeout(buildForecastPrice(upper, metrics.currentPrice), 2000);
          forecastPrice = fc;
          growthPct = ((fc - metrics.currentPrice) / metrics.currentPrice) * 100;
        } catch { /* keep defaults */ }
      }
    } catch {
      try {
        const fc = await withTimeout(buildForecastPrice(upper, metrics.currentPrice), 2000);
        forecastPrice = fc;
        growthPct = ((fc - metrics.currentPrice) / metrics.currentPrice) * 100;
      } catch { /* keep defaults */ }
    }


    // 3) News sentiment — LITE (RSS only, no per-article fetch)
    // keeps this endpoint fast/reliable on free hosting
    let news = { averageSentiment: 0, topStories: [] };
    try {
      const feed = await withTimeout(
        rssParser.parseURL(`https://news.google.com/rss/search?q=${upper}`),
        3000
      );
      const items = (feed.items || []).slice(0, 5).map(i => {
        const snippet = (i.contentSnippet || i.title || '').slice(0, 200);
        return { title: i.title, link: i.link, snippet };
      });
      const scores = items.map(x => sentiment.analyze(x.snippet).score);
      const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0;
      news = { averageSentiment: avg, topStories: items };
    } catch (_) {
      // swallow; keep default empty news
    }



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
        const userId = req.user?.userId || req.headers['x-user-id'] || null;
        const t = await getTechnicalForUser(upper, userId);

        // Only include plain JSON-safe fields (NO raw object)
        const ind = t?.indicators || {};
        const lev = t?.levels || {};
        technicalDetail = {
          rsi14:  Number.isFinite(ind.RSI14)  ? ind.RSI14  : null,
          macd:   Number.isFinite(ind.MACD)   ? ind.MACD   : null,
          sma50:  Number.isFinite(ind.SMA50)  ? ind.SMA50  : null,
          sma200: Number.isFinite(ind.SMA200) ? ind.SMA200 : null,
          atr14:  Number.isFinite(ind.ATR14)  ? ind.ATR14  : null,
          trend:  t?.trend ?? (() => {
            const s50 = ind.SMA50, s200 = ind.SMA200;
            if (Number.isFinite(s50) && Number.isFinite(s200)) {
              return s50 > s200 ? "uptrend" : (s50 < s200 ? "downtrend" : "sideways");
            }
            return "sideways";
          })(),
          levels: {
            support: Number.isFinite(lev.support)    ? lev.support    :
                    (Number.isFinite(metrics.dayLow) ? metrics.dayLow : metrics.fiftyTwoWeekLow ?? null),
            resistance: Number.isFinite(lev.resistance) ? lev.resistance :
                        (Number.isFinite(metrics.dayHigh) ? metrics.dayHigh : metrics.fiftyTwoWeekHigh ?? null),
          },
          suggestion:   t?.suggestion ?? null,
          instructions: t?.instructions ?? null,
          chartUrl:     (typeof t?.chartUrl === 'string') ? t.chartUrl : null
          // DO NOT: raw: t
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
    const classification =
      growthPct >= 2 ? "growth" :
      growthPct >= 0 ? "stable" :
      "decline";

    const combinedScore = +(0.2 * quickRating + 0.8 * growthPct).toFixed(2);
    const advice =
      classification === "growth"
        ? "Projected to grow. Consider buying."
        : classification === "stable"
        ? "Minimal growth expected. Hold or monitor."
        : "Projected to decline. Consider selling or avoiding.";

    // Personalized Advisor Suggestion
    let advisorSuggestion = null;
    try {
      const profile = await getUserProfile(req); // pulls from Firebase token or x-user-id
      advisorSuggestion = await buildAdvisorSuggestion({
        symbol: upper,
        profile,
        baseAdvice: advice,
        fundamentals: fundamentalDetail,
        technical: technicalDetail,
        metrics
      });
    } catch (_) { /* swallow */ }

    const payload = {
      ...base,
      fundamentalRating: quickRating.toFixed(2),
      combinedScore,
      classification,
      advice,
      advisorSuggestion,
      forecast: {
        forecastPrice: +forecastPrice.toFixed(2),
        projectedGrowthPercent: `${growthPct.toFixed(2)}%`,
        forecastPeriod: "Close",
        forecastEndDate: getForecastEndTime(),
      },
      fundamentals: fundamentalDetail || {},
      technical: technicalDetail || {},
      news
    };

    try {
      return res.json(payload);
    } catch (e) {
      console.error("check-stock serialize error:", e);
      return res.status(500).json({ message: `serialize-failed: ${e.message}` });
    }
    } catch (err) {
      console.error("check-stock route error:", err);
      return res.status(500).json({ message: "Server error." });
    }
    });


// POST /api/advisor/chat  (requires Firebase auth)
function mergeFacts(oldFacts = {}, inc = {}) {
  const out = { ...oldFacts };
  for (const [k, v] of Object.entries(inc)) {
    if (v == null) continue;
    if (k === 'watchlist' && Array.isArray(v)) {
      const set = new Set([...(out.watchlist || []), ...v.map(s => String(s).toUpperCase())]);
      out.watchlist = Array.from(set);
    } else if (k === 'sectorLimits' && typeof v === 'object') {
      out.sectorLimits = { ...(out.sectorLimits || {}), ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function extractFactsAdaptive(messages) {
  const system = `You extract durable investing preferences from a chat.
Return ONLY compact JSON with optional keys:
{ "riskTolerance": "low|medium|high",
  "horizon": "short|medium|long",
  "maxPositionPct": number,
  "stopLossPct": number,
  "watchlist": ["TICK","ER"],
  "sectorLimits": {"Tech":30,...},
  "notes": "1 short sentence if useful" }`;
  try {
    const text = await callChatServiceAdaptive({
      system,
      messages: messages.slice(-4) // last few turns are enough
    });
    try { return JSON.parse(text); } catch { return {}; }
  } catch {
    return {};
  }
}


app.get('/api/research-pack/:symbol', authenticate, async (req,res)=>{
  try{
    const sym = String(req.params.symbol||'').toUpperCase();
    if(!isValidSymbol(sym)) return res.status(404).json({message:'unknown symbol'});
    const pack = await buildResearchPack(sym);
    res.json(pack);
  }catch(e){
    console.error('research-pack', e.message);
    res.status(500).json({message:'failed'});
  }
});



function detectHorizonFromMessages(messages = []) {
  const text = [...messages]
    .reverse()
    .map(m => (m.role || 'user') === 'user' ? String(m.content || '') : '')
    .join(' ')
    .toLowerCase();

  // strong long-term keywords
  const longHits = /\b(long[-\s]?term|years|multi[-\s]?year|retirement|hold (for )?\d+\s*(years|yrs)|5\+ years|decade|buy and hold)\b/i;
  // strong short-term keywords
  const shortHits = /\b(short[-\s]?term|next (day|week)|this (week|month)|swing|day[-\s]?trade|entry|stop[-\s]?loss|target|breakout|scalp|intraday)\b/i;

  if (longHits.test(text)) return 'long';
  if (shortHits.test(text)) return 'short';
  return 'auto'; // default → we’ll choose based on user profile or fall back to short for trading phrases
}



// POST /api/advisor/chat  (requires Firebase auth)
app.post('/api/advisor/chat', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messages = [], context = {} } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ text: 'messages[] is required' });
    }

    // ── Profile + memory
    const profile = await getUserProfile(req).catch(() => null);
    const memDoc  = (await ChatMemory.findOne({ userId })) || new ChatMemory({ userId });
    const memory  = memDoc.facts || {};

    // ── Intent classification (LLM first, with heuristic fallback)
    async function classifyIntent(msgs) {
      const sys = `
Return STRICT JSON for user's last message with fields:
{"intent":"greet|ideas|ticker_question|portfolio_sizing|risk_policy|education|macro|watchlist_update|other",
 "symbols":["TICK","ER"]}

Rules:
- "ticker_question" if they ask about, compare, buy/hold/sell, or mention a ticker/company.
- "ideas" for "what should I buy", "picks", "recommendations", "watchlist suggestions".
- "portfolio_sizing" for "how much", "position size", "allocation", "risk %", "diversify".
- "education" for definitions/explain ("what is PE", "how does MACD work").
- "macro" for market/sector/economy outlook.
- "greet" for small talk.
Include up to 2 detected symbols. Output JSON only.
`.trim();

      try {
        const out = await callChatServiceAdaptive({ system: sys, messages: msgs.slice(-4) });
        const parsed = JSON.parse(out);
        if (parsed && parsed.intent) return parsed;
      } catch {}
      // heuristic fallback
      const last = (msgs[msgs.length - 1]?.content || '').toUpperCase();
      const syms = (last.match(/\b[A-Z]{1,5}\b/g) || []).filter(isValidSymbol).slice(0, 2);
      if (syms.length) return { intent: 'ticker_question', symbols: syms };
      if (/\b(PICK|BUY|IDEA|RECOMMEND|WATCHLIST)\b/.test(last)) return { intent: 'ideas', symbols: [] };
      if (/\b(ALLOCATION|SIZE|SIZING|POSITION|RISK|STOP)\b/.test(last)) return { intent: 'portfolio_sizing', symbols: [] };
      if (/\bWHAT IS|HOW WORKS|EXPLAIN|MEAN\b/.test(last)) return { intent: 'education', symbols: [] };
      if (/\bHELLO|HI|HEY\b/.test(last)) return { intent: 'greet', symbols: [] };
      return { intent: 'other', symbols: [] };
    }

    const { intent, symbols: classifiedSyms = [] } = await classifyIntent(messages);

    // ── pick a symbol if present in context or classification
    const ctx = { ...context };
    if (!ctx.symbol && classifiedSyms.length) ctx.symbol = classifiedSyms[0];

    const horizonIntent = detectHorizonFromMessages(messages); // 'long' | 'short' | 'auto'

    // ── helper: quick picks (2–3 names) using your short-term model
    async function quickPicksForUser(profile) {
      const risk = String(profile?.riskTolerance || 'medium').toLowerCase();
      const minPrice = risk === 'low' ? 10 : risk === 'medium' ? 5 : 2;
      const maxPrice = risk === 'low' ? 300 : risk === 'medium' ? 250 : 400;

      // sample a light universe for speed
      const universe = symbolsList.slice(0, 120).map(s => (typeof s === 'string' ? s : s.symbol));

      const rows = await mapLimit(universe, 6, async (sym) => {
        try {
          const yq = await fetchStockData(sym).catch(() => null);
          const price = yq?.price?.regularMarketPrice;
          if (!price || price < minPrice || price > maxPrice) return null;

          const st = await computeShortTermExpectedMove(sym).catch(() => null);
          if (!st) return null;

          return {
            symbol: sym,
            price,
            pUp: +(st.pUp * 100).toFixed(1),
            magnitudePct: +(st.magnitude * 100).toFixed(2),
            expectedReturnPct: +(st.expectedReturn * 100).toFixed(2)
          };
        } catch { return null; }
      });

      const valid = rows.filter(Boolean);
      valid.sort((a, b) => (b.expectedReturnPct - a.expectedReturnPct) || (b.pUp - a.pUp));
      return valid.slice(0, 3);
    }

    // ── assemble context if a symbol is present
    let llmContext = {
      symbol: ctx.symbol || null,
      live: null,
      checkerMetrics: null,
      finder: null,
      fundamentals: null,
      tech: null,
      stModel: null,
      researchText: null,
      horizonIntent
    };

    if (ctx.symbol) {
      const sym  = String(ctx.symbol).toUpperCase();
      const pack = await buildResearchPack(sym).catch(() => null);

      // short-term model snapshot
      let stModel = null;
      if (pack?.shortTerm) {
        stModel = {
          pUpPct: pack.shortTerm.pUpPct,
          magnitudePct: pack.shortTerm.magnitudePct,
          expectedReturnPct: pack.shortTerm.expectedReturnPct
        };
      } else {
        const st = await computeShortTermExpectedMove(sym).catch(() => null);
        if (st) {
          stModel = {
            pUpPct: +(st.pUp * 100).toFixed(1),
            magnitudePct: +(st.magnitude * 100).toFixed(2),
            expectedReturnPct: +(st.expectedReturn * 100).toFixed(2)
          };
        }
      }

      const techSlim = pack?.technical ? {
        trend: pack.technical.trend ?? null,
        levels: pack.technical.levels ?? null,
        indicators: pack.technical.indicators ?? null
      } : null;

      llmContext = {
        ...llmContext,
        live: pack?.live || null,
        checkerMetrics: pack?.metrics || null,
        finder: pack?.finder || null,
        fundamentals: pack?.fundamentals ? {
          rating: pack.fundamentals.rating ?? null,
          weaknesses: pack.fundamentals.weaknesses ?? [],
          ratios: pack.fundamentals.ratios ?? {},
          benchmarks: pack.fundamentals.benchmarks ?? {},
          valuation: pack.fundamentals.valuation ?? null
        } : null,
        tech: techSlim,
        stModel,
        researchText: (pack?.research?.text || '').slice(0, 1800)
      };
    }

    // ── build the system prompt with intent routing
    let system;
    if (ctx.symbol || intent === 'ticker_question') {
      system = `
You are SCI's AI equity advisor.

Use ONLY the provided Context (live snapshot, fundamentals/benchmarks, Finder score+reasons, short-term model), the user's Profile & Memory, and the researchText.
Never invent prices. Personalize to risk/horizon.

Format (≤180 words):
1) Snapshot — name, price, 52w position. Include quick rating and Finder score with one reason.
2) Core View — short-term if horizonIntent ≠ 'long'; otherwise long-term thesis (bullets) using researchText.
3) Action — buy/hold/avoid with risk notes (sizing aligned to profile); if short-term, you may suggest entry/stop/target ranges implied by support/resistance/ATR if available; otherwise keep high-level.

Data:
Intent: ${intent}
Profile: ${JSON.stringify(profile || {})}
Memory:  ${JSON.stringify(memory || {})}
Context: ${JSON.stringify(llmContext || {})}
`.trim();
    } else if (intent === 'portfolio_sizing' || intent === 'risk_policy') {
      system = `
You are a portfolio coach. The user asked about position sizing/risk.
Use Profile & Memory (riskTolerance, maxPositionPct, stopLossPct, portfolioSize) if available.
If numbers are missing, provide a clear framework (e.g., risk 0.5–1.5% of equity per trade; derive share count from stop distance).
Give an example with round numbers. Keep it ≤160 words.

Profile: ${JSON.stringify(profile || {})}
Memory:  ${JSON.stringify(memory || {})}
`.trim();
    } else if (intent === 'ideas') {
      // fetch quick picks (no ticker given)
      const picks = await quickPicksForUser(profile).catch(() => []);
      const picksLite = picks.map(p => ({
        symbol: p.symbol, price: p.price,
        pUp: p.pUp, magnitudePct: p.magnitudePct, expectedReturnPct: p.expectedReturnPct
      }));
      system = `
You are SCI's stock scout. The user wants ideas/picks without giving a ticker.
Use the short-term model picks provided below. Personalize to Profile/Memory (risk, horizon, sectors).
Output a short list (2–3 bullets) with each pick's price and brief rationale (probability/magnitude or quality).
Close with a nudge that you can deep-dive any of them.

Profile: ${JSON.stringify(profile || {})}
Memory:  ${JSON.stringify(memory || {})}
Picks:   ${JSON.stringify(picksLite || [])}
`.trim();
    } else if (intent === 'education') {
      system = `
You are a concise explainer for investing concepts (≤160 words).
Use simple language, one mini example, and one caution/pitfall. No symbols required.
Profile (to adjust tone): ${JSON.stringify(profile || {})}
`.trim();
    } else if (intent === 'greet' || intent === 'other' || intent === 'macro' || intent === 'watchlist_update') {
      // friendly general assistant + quick capability summary; try to be helpful immediately
      const picks = await quickPicksForUser(profile).catch(() => []);
      const picksLite = picks.map(p => ({ symbol: p.symbol, expectedReturnPct: p.expectedReturnPct }));
      system = `
You are SCI's AI financial assistant. The user didn't provide a ticker.
Greet briefly and show what you can do (1 short line).
Offer 2 quick actionable options tailored to Profile/Memory (e.g., "get ideas", "size a position", "analyze your watchlist").
If Picks are supplied, mention 1–2 tickers with their expected-return snapshot as "quick ideas".
Keep it ≤120 words.

Profile: ${JSON.stringify(profile || {})}
Memory:  ${JSON.stringify(memory || {})}
Picks:   ${JSON.stringify(picksLite || [])}
`.trim();
    }

    // ── call the model
    let reply = await callChatServiceAdaptive({ system, messages });

    // ── never return empty
    if (!reply || !String(reply).trim()) {
      const fallback = ctx.symbol
        ? `I loaded data for ${ctx.symbol} but couldn't reach the model. Try again in a moment or ask for ideas.`
        : `I can give ideas, size positions, or analyze a ticker. For example, say “ideas” or “AAPL analysis”.`;
      reply = fallback;
    }

    // ── durable memory extraction/update
    try {
      const facts = await extractFactsAdaptive([...messages, { role: 'assistant', content: reply }]);
      if (facts && Object.keys(facts).length) {
        memDoc.facts     = mergeFacts(memDoc.facts, facts);
        memDoc.summary   = `Last update: ${new Date().toISOString()}`;
        memDoc.updatedAt = new Date();
        await memDoc.save();
      }
    } catch (e) {
      console.warn('memory update skipped:', e.message);
    }

    return res.json({ text: String(reply) });
  } catch (e) {
    console.error('chat route error:', e.message);
    const status = /missing|required|400/.test(e.message) ? 400 : 500;
    return res.status(status).json({ text: `Chat error: ${e.message}` });
  }
});




app.get('/api/price/:symbol', authenticate, async (req, res) => {
  try {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!sym) return res.status(400).json({ error: 'symbol required' });
    if (!isValidSymbol(sym)) return res.status(404).json({ error: 'unknown symbol' });

    const q = await yahooFinance.quote(sym, {}, { fetchOptions: requestOptions });
    if (!q?.regularMarketPrice) return res.status(404).json({ error: 'no price' });

    return res.json({ symbol: sym, price: q.regularMarketPrice, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error('price endpoint:', e.message);
    res.status(502).json({ error: 'price provider failed' });
  }
});
app.get("/api/model/shortterm/:symbol", async (req, res) => {
  try {
    const sym = String(req.params.symbol || "").toUpperCase();
    if (!sym) return res.status(400).json({ message: "symbol required" });
    if (!isValidSymbol(sym)) return res.status(404).json({ message: "unknown symbol" });
    const r = await computeShortTermExpectedMove(sym);
    return res.json({
      symbol: sym,
      pUp: +(r.pUp).toFixed(4),
      magnitudePct: +(r.magnitude * 100).toFixed(3),
      expectedReturnPct: +(r.expectedReturn * 100).toFixed(3),
      expectedIncreasePct: +(r.expectedIncrease * 100).toFixed(3),
      diagnostics: r.diagnostics
    });
  } catch (e) {
    console.error("shortterm model:", e.message);
    return res.status(500).json({ message: "Model error" });
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
|  Short-term expected move (T+1, daily)   |
|  Probability × Magnitude model           |
└──────────────────────────────────────────*/

// tiny cache to avoid recomputing repeatedly (10 min)
const ST_EXPECTED_CACHE = new Map();
const ST_TTL_MS = 10 * 60 * 1000;

const stClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const stSigmoid = z => 1 / (1 + Math.exp(-z));

// fetch ~120 trading days of daily bars
async function stGetDaily(symbol, days = 120) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await yahooFinance.historical(
    symbol,
    { period1: start, period2: end, interval: "1d" },
    { fetchOptions: requestOptions }
  );
  const data = (rows || [])
    .map(r => ({
      date: new Date(r.date),
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume
    }))
    .filter(r => Number.isFinite(r.open) && Number.isFinite(r.close) && Number.isFinite(r.high) && Number.isFinite(r.low) && Number.isFinite(r.volume))
    .sort((a,b)=>a.date-b.date);
  return data;
}

// indicators: EMA, RSI14, ATR14, MACD(12,26,9), BBands(20), OBV, z-score
function stEMA(vals, period) {
  const k = 2 / (period + 1);
  let e = vals[0];
  const out = [e];
  for (let i = 1; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function stRSI14(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= p; loss /= p;
  let rs = loss === 0 ? 100 : gain / loss;
  let rsi = 100 - (100 / (1 + rs));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (p - 1) + g) / p;
    loss = (loss * (p - 1) + l) / p;
    rs = loss === 0 ? 100 : gain / loss;
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
}
function stATR14(rows, p = 14) {
  if (rows.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const e = stEMA(trs, p);
  return e[e.length - 1];
}
function stMACD(closes, fast = 12, slow = 26, sigP = 9) {
  if (closes.length < slow + sigP + 5) return { macd: null, signal: null, hist: null };
  const ef = stEMA(closes, fast);
  const es = stEMA(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const sig = stEMA(line.slice(-sigP - 50), sigP).pop();
  const val = line[line.length - 1];
  return { macd: val, signal: sig, hist: val - sig };
}
function stBBands(closes, p = 20) {
  if (closes.length < p) return { upper: null, lower: null, pctB: null, sma: null, std: null };
  const arr = closes.slice(-p);
  const sma = arr.reduce((s, x) => s + x, 0) / p;
  const std = Math.sqrt(arr.reduce((s, x) => s + (x - sma) ** 2, 0) / p);
  const upper = sma + 2 * std, lower = sma - 2 * std;
  const last = closes[closes.length - 1];
  const pctB = (last - lower) / (upper - lower);
  return { upper, lower, pctB, sma, std };
}
function stOBV(rows) {
  let v = 0;
  for (let i = 1; i < rows.length; i++) {
    const dir = Math.sign(rows[i].close - rows[i - 1].close);
    v += dir * rows[i].volume;
  }
  return v;
}
function stZ(series) {
  if (series.length < 2) return 0;
  const m = series.reduce((s, x) => s + x, 0) / series.length;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - m) ** 2, 0) / series.length) || 1e-6;
  return (series[series.length - 1] - m) / sd;
}

// Main calculator: returns { pUp, magnitude, expectedReturn, expectedIncrease, diagnostics }
async function computeShortTermExpectedMove(symbol) {
  const cache = ST_EXPECTED_CACHE.get(symbol);
  if (cache && (Date.now() - cache.ts) < ST_TTL_MS) return cache.val;

  const rows = await stGetDaily(symbol, 130);
  if (!rows || rows.length < 40) throw new Error("Not enough history");

  const closes = rows.map(r => r.close);
  const vols   = rows.map(r => r.volume);
  const last   = rows[rows.length - 1];

  // Feature engineering (t uses last bar)
  const ret1d   = (closes[closes.length - 1] / closes[closes.length - 2]) - 1;
  const mom5    = (closes[closes.length - 1] / closes[closes.length - 6]) - 1;
  const rangePct= (last.high - last.low) / last.close;
  const gapPct  = (last.open / closes[closes.length - 2]) - 1;

  const RSI     = stRSI14(closes, 14);
  const { hist: MACDh } = stMACD(closes);
  const { pctB } = stBBands(closes, 20);
  const ATR     = stATR14(rows, 14);
  const atrPct  = ATR ? ATR / last.close : 0.01;

  // volume/OBV z-scores over 60d
  const volZ = stZ(vols.slice(-60));
  const obvSeries = [];
  for (let i = rows.length - 60; i < rows.length; i++) {
    obvSeries.push(stOBV(rows.slice(0, i + 1)));
  }
  const obvZ = stZ(obvSeries);

  // Normalize into bounded features
  const rsiN   = (RSI != null) ? stClamp((RSI - 50) / 10, -3, 3) : 0;         // ±30pts → ±3
  const macdN  = (MACDh != null && ATR) ? stClamp(MACDh / ATR, -3, 3) : 0;    // MACD hist vs ATR
  const mom5N  = stClamp(mom5 / 0.05, -3, 3);                                  // 5% → 1.0
  const gapN   = stClamp(gapPct / 0.01, -3, 3);                                 // 1% gap → 1.0
  const rngN   = stClamp(rangePct / 0.03, 0, 3);                                // 3% range → 1.0
  const bbN    = (pctB != null) ? stClamp((pctB - 0.5) * 2, -2, 2) : 0;        // [-1..+1] → [-2..2]
  const volN   = stClamp(volZ, -3, 3);
  const obvN   = stClamp(obvZ, -3, 3);

  // Direction probability (logistic blend) – tunable weights
  const z =
      0.15
    + 0.8  * rsiN
    + 0.6  * macdN
    + 0.5  * mom5N
    + 0.3  * gapN
    + 0.2  * bbN
    + 0.15 * volN
    + 0.10 * obvN
    - 0.2  * rngN;

  const pUp = stSigmoid(z);

  // Magnitude = expected |move| (%)
  const magnitude = stClamp(
    (atrPct || 0.01) * (1
      + 0.25 * Math.abs(volN)
      + 0.35 * Math.abs(macdN)
      + 0.20 * Math.abs(gapN)
      + 0.25 * Math.abs(mom5N)
    ),
    0.002, 0.08   // 0.2% .. 8%
  );

  const expectedReturn   = (2 * pUp - 1) * magnitude; // signed %
  const expectedIncrease = pUp * magnitude;           // chance-adjusted %

  const out = {
    pUp,                       // 0..1
    magnitude,                 // abs move, as decimal (e.g. 0.012 = 1.2%)
    expectedReturn,            // signed decimal
    expectedIncrease,          // decimal
    diagnostics: { RSI, MACDh, pctB, atrPct, ret1d, mom5, rangePct, gapPct, volZ, obvZ }
  };
  ST_EXPECTED_CACHE.set(symbol, { val: out, ts: Date.now() });
  return out;
}



/*──────────────────────────────────────────
|  13) FINDER (v2.2, light+heavy passes)   |
└──────────────────────────────────────────*/
const finderRouter = express.Router();
finderRouter.use("/find-stocks", findStockLimiter);

// --- tiny in-memory cache ---
const finderQuoteCache = new Map();
function setCached(key, val) { finderQuoteCache.set(key, { val, ts: Date.now() }); }
function getCached(key, ttlMs = 60 * 60 * 1000) {
  const hit = finderQuoteCache.get(key);
  return hit && (Date.now() - hit.ts < ttlMs) ? hit.val : null;
}

// --- helpers (same as before) ---
function extractQuoteFeatures(yq) {
  const p  = yq?.price || {};
  const sd = yq?.summaryDetail || {};
  const fd = yq?.financialData || {};
  return {
    name: p.longName || p.shortName || null,
    price: p.regularMarketPrice ?? null,
    vol:   p.regularMarketVolume ?? null,
    avgVol: sd.averageDailyVolume3Month ?? p.regularMarketVolume ?? 0,
    pe: sd.trailingPE ?? null,
    ps: sd.priceToSalesTrailing12Months ?? null,
    pb: sd.priceToBook ?? null,
    div: sd.dividendYield ?? null,
    wkHi: sd.fiftyTwoWeekHigh ?? null,
    wkLo: sd.fiftyTwoWeekLow ?? null,
    dayHi: p.regularMarketDayHigh ?? null,
    dayLo: p.regularMarketDayLow ?? null,
    growth: fd.earningsGrowth ?? null,
    debtToEq: fd.debtToEquity ?? null,
    grossMargin: fd.grossMargins ?? null,
    opMargin: fd.operatingMargins ?? null,
    rsi14: null
  };
}

function baseScore(f) {
  let score = 0; const reasons = [];
  if (f.avgVol && f.avgVol >= 1_000_000) { score += 4; reasons.push("Good liquidity (avg vol ≥1M)"); }
  else if (f.avgVol && f.avgVol >= 250_000) { score += 2; reasons.push("OK liquidity (avg vol ≥250k)"); }
  else { reasons.push("Thinly traded"); }
  if (f.pe && f.pe > 4 && f.pe < 30) { score += 3; reasons.push("Reasonable PE"); }
  else if (f.ps && f.ps < 8) { score += 1; reasons.push("P/S acceptable"); }
  else { score -= 1; reasons.push("Valuation rich/unknown"); }
  if (typeof f.growth === "number") {
    if (f.growth > 0.15) { score += 4; reasons.push("Strong earnings growth"); }
    else if (f.growth > 0.03) { score += 2; reasons.push("Modest earnings growth"); }
    else if (f.growth < 0) { score -= 2; reasons.push("Negative earnings growth"); }
  }
  if (typeof f.debtToEq === "number") {
    if (f.debtToEq < 0.6) { score += 3; reasons.push("Low leverage"); }
    else if (f.debtToEq > 1.5) { score -= 2; reasons.push("High leverage"); }
  }
  if (typeof f.grossMargin === "number" && f.grossMargin > 0.4) { score += 2; reasons.push("Healthy gross margin"); }
  if (typeof f.opMargin === "number" && f.opMargin > 0.15) { score += 2; reasons.push("Solid operating margin"); }
  if (f.wkHi != null && f.wkLo != null && f.price != null && f.wkHi > f.wkLo) {
    const pos = (f.price - f.wkLo) / (f.wkHi - f.wkLo);
    if (pos < 0.3) { score += 2; reasons.push("Near 52w lows (value tilt)"); }
    else if (pos > 0.9) { score -= 1; reasons.push("Near 52w highs (breakout risk)"); }
  }
  if (typeof f.rsi14 === "number") {
    if (f.rsi14 < 30) { score += 2; reasons.push("RSI oversold"); }
    if (f.rsi14 > 70) { score -= 1; reasons.push("RSI overbought"); }
  }
  return { score, reasons };
}

// Bounded parallel mapper
async function mapLimit(items, concurrency, mapper) {
  const out = new Array(items.length);
  let i = 0, active = 0;
  return new Promise((resolve, reject) => {
    const kick = () => {
      while (active < concurrency && i < items.length) {
        const idx = i++; active++;
        Promise.resolve(mapper(items[idx], idx))
          .then(v => { out[idx] = v; active--; (i >= items.length && active === 0) ? resolve(out) : kick(); })
          .catch(reject);
      }
    };
    kick();
  });
}

async function safeForecast(sym, price) {
  try {
    const cached = getCached(`fc:${sym}`, 12 * 60 * 60 * 1000);
    if (cached) return cached;
    const fc = await buildForecastPrice(sym, price);
    setCached(`fc:${sym}`, fc);
    return fc;
  } catch { return null; }
}

// ---------- main route ----------
finderRouter.post("/find-stocks", async (req, res) => {
  try {
    const {
      stockType = "growth",         // 'growth' | 'stable'
      exchange = "NASDAQ",          // 'NASDAQ' | 'NYSE' | 'TSX'
      minPrice = 5,
      maxPrice = 150,
      horizon  = "short",           // 'short' | 'long'
      topK = 20,
      universeLimit = 200,
      includeAdvisor = false,
      // floor for growth screen (only used when stockType==='growth')
      minGrowthPct = stockType === "growth" ? 1 : -100
    } = req.body || {};

    // 1) Universe by exchange
    const tickers = symbolsList
      .filter(s => (typeof s === "string" ? true : (s.exchange || s.ex || "").toUpperCase() === exchange))
      .map(s => (typeof s === "string" ? s : s.symbol))
      .slice(0, universeLimit);

    // 2) LIGHT PASS (price/volume only) — very fast
    const lightRows = (await mapLimit(tickers, 12, async (sym) => {
      const q = await getLightQuote(sym);
      if (!q) return null;

      const price = q.regularMarketPrice;
      if (!price || price < minPrice || price > maxPrice) return null;

      return {
        symbol: sym,
        price,
        vol: q.regularMarketVolume || 0,
        wkHi: q.fiftyTwoWeekHigh ?? null,
        wkLo: q.fiftyTwoWeekLow ?? null,
        dayHi: q.regularMarketDayHigh ?? null,
        dayLo: q.regularMarketDayLow ?? null,
      };
    })).filter(Boolean);

    // prefer liquid names; keep a small working set
    lightRows.sort((a,b) => (b.vol - a.vol));
    const working = lightRows.slice(0, Math.max(24, topK * 2));  // SMALL slice

    // 2.5) HEAVY PASS (quoteSummary) only on "working" set
    const prelim = (await mapLimit(working, 6, async (w) => {
      const yq = await fetchStockData(w.symbol);
      if (!yq) return null;

      const f = extractQuoteFeatures(yq);
      // carry over the fast fields so we never miss basics
      f.price  = f.price  ?? w.price;
      f.avgVol = f.avgVol ?? w.vol;
      f.wkHi   = f.wkHi   ?? w.wkHi;
      f.wkLo   = f.wkLo   ?? w.wkLo;
      f.dayHi  = f.dayHi  ?? w.dayHi;
      f.dayLo  = f.dayLo  ?? w.dayLo;

      const bs = baseScore(f);

      // horizon screens
      let pass = true;
      const horizonNotes = [];
      if (horizon === "short") {
        if (!f.avgVol || f.avgVol < 250_000) { pass = false; horizonNotes.push("Insufficient liquidity"); }
        if (f.wkHi && f.wkLo && f.price && f.wkHi > f.wkLo) {
          const pos = (f.price - f.wkLo) / (f.wkHi - f.wkLo);
          if (pos > 0.95) { pass = false; horizonNotes.push("Too extended near 52w high"); }
        }
        if (typeof f.debtToEq === "number" && f.debtToEq > 2.5) { pass = false; horizonNotes.push("Excess leverage"); }
      } else {
        if (bs.score < 10) { pass = false; horizonNotes.push("Quality score below long-term bar (10)"); }
        if (typeof f.debtToEq === "number" && f.debtToEq > 1.2) { pass = false; horizonNotes.push("Debt/equity too high"); }
        if (typeof f.grossMargin === "number" && f.grossMargin < 0.3) { pass = false; horizonNotes.push("Gross margin <30%"); }
      }
      if (!pass) return null;

      return { symbol: w.symbol, features: f, base: bs, horizonNotes };
    })).filter(Boolean);

    // 3) Rank & slice for forecasting (smaller than before)
    prelim.sort((a,b) => (b.base.score - a.base.score) || ((b.features.avgVol||0) - (a.features.avgVol||0)));
    const slice = prelim.slice(0, Math.max(18, topK * 2));

    // 4) Forecast pass on slice
    const forecasted = await mapLimit(slice, 8, async (row) => {
      const { symbol, features, base, horizonNotes } = row;

      let forecastPrice = null;
      let growthPct = null;            // % change for T+1
      let classification = "unknown";

      if (horizon === "short") {
        const st = await computeShortTermExpectedMove(symbol).catch(() => null);
        if (st && features.price) {
          const expR = st.expectedReturn;  // signed decimal
          growthPct = expR * 100;
          forecastPrice = +(features.price * (1 + expR)).toFixed(2);
          horizonNotes.push(
            `Short-term model: p_up ${(st.pUp * 100).toFixed(0)}%, |move| ${(st.magnitude * 100).toFixed(1)}%`
          );
        }
      } else {
        const fc = await safeForecast(symbol, features.price);
        if (fc && features.price) {
          growthPct = ((fc - features.price) / features.price) * 100;
          forecastPrice = +fc.toFixed(2);
        }
      }

      if (growthPct != null) {
        classification = growthPct >= 2 ? "growth" : (growthPct >= 0 ? "stable" : "unstable");
      }

      return {
        symbol,
        name: features.name,
        exchange,
        price: features.price,
        avgVol: features.avgVol,
        score: base.score,
        reasons: [...base.reasons, ...horizonNotes],
        forecastPrice,
        growthPct,
        classification
      };
    });

    // 5) Policy filters (type + horizon) + minGrowth floor
    const accept = (row) => {
      if (row.growthPct == null || row.forecastPrice == null) return false;

      if (stockType === "growth") {
        if (row.growthPct < minGrowthPct) return false;
        if (horizon === "short") {
          if (row.avgVol < 250_000) return false;
        } else {
          if (row.score < 12) return false;
        }
        return true;
      }

      if (stockType === "stable") {
        const inBand = row.growthPct >= -1 && row.growthPct <= 2;
        const qualityOK = row.score >= (horizon === "long" ? 8 : 5);
        return inBand && qualityOK;
      }

      return true;
    };

    const filtered = forecasted.filter(accept);

    // 6) Final sort & trim
    filtered.sort((a,b) =>
      (b.score - a.score) ||
      ((b.growthPct ?? -999) - (a.growthPct ?? -999)) ||
      ((b.avgVol||0) - (a.avgVol||0))
    );

    const out = filtered.slice(0, topK);

    // === optional per-pick AI Advisor (topK only) ===
    if (includeAdvisor && out.length) {
      try {
        const profile = await getUserProfile(req); // may be null
        await mapLimit(out, 3, async (row) => {
          const baseAdvice =
            row.classification === "growth"
              ? `Projected to grow ~${row.growthPct?.toFixed(2)}%. Quality score ${row.score}.`
              : row.classification === "stable"
              ? `Projected to be stable (~${row.growthPct?.toFixed(2)}%). Quality score ${row.score}.`
              : `Uncertain projection. Quality score ${row.score}.`;

          const suggestion = await buildAdvisorSuggestion({
            symbol: row.symbol,
            profile,
            baseAdvice,
            fundamentals: null,
            technical: null,
            metrics: {
              currentPrice: row.price,
              avgVolume: row.avgVol,
              growthPct: row.growthPct,
              qualityScore: row.score,
              classification: row.classification,
            },
          }).catch(() => null);

          if (suggestion && String(suggestion).trim()) {
            row.advisorSuggestion = String(suggestion).trim();
          } else if (profile) {
            row.advisorSuggestion = `Advisor Suggestion: ${baseAdvice}`;
          } else {
            row.advisorSuggestion = "Advisor Suggestion: Sign in for a personalized plan, or open the Stock Checker for deeper analysis.";
          }
        });
      } catch (e) {
        console.warn("Finder advisor step:", e.message);
      }
    }

    return res.json({ stocks: out, meta: { horizon, minGrowthPct, topK, universeLimit } });
  } catch (err) {
    console.error("Finder v2.1 error:", err);
    return res.status(500).json({ message: "Finder server error." });
  }
});


app.use(["/api", "/finder/api"], finderRouter);



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

/* 1.5️⃣  BEST-BUYS (short-term, probability-based) — cached + lighter */
app.get("/api/best-buys*", async (_req, res) => {
  try {
    // serve cached result if fresh
    if (BEST_BUYS_CACHE.data && (Date.now() - BEST_BUYS_CACHE.ts) < BEST_BUYS_TTL_MS) {
      return res.json({ picks: BEST_BUYS_CACHE.data });
    }

    // smaller universe + polite batching keeps Render happy
    const sample = symbolsList
      .slice(0, 120) // was 200 — tighten for latency on free tier
      .map(s => (typeof s === "string" ? s : s.symbol));

    const results = [];
    for (const group of chunk(sample, 10)) {           // smaller batch than before
      const batch = await Promise.all(
        group.map(async (sym) => {
          try {
            const q = await fetchStockData(sym).catch(() => null);
            const price = q?.price?.regularMarketPrice;
            if (!price) return null;

            const st = await computeShortTermExpectedMove(sym).catch(() => null);
            if (!st) return null;

            return {
              symbol: sym,
              price,
              pUp: +(st.pUp * 100).toFixed(1),
              magnitudePct: +(st.magnitude * 100).toFixed(2),
              expectedReturnPct: +(st.expectedReturn * 100).toFixed(2)
            };
          } catch { return null; }
        })
      );
      results.push(...batch.filter(Boolean));
    }

    results.sort((a, b) => (b.pUp - a.pUp) || (b.expectedReturnPct - a.expectedReturnPct));

    const picks = results.slice(0, 5);

    // cache & return
    BEST_BUYS_CACHE.ts = Date.now();
    BEST_BUYS_CACHE.data = picks;

    return res.json({ picks });
  } catch (e) {
    console.error("best-buys:", e.message);
    return res.status(500).json({ picks: [] });
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
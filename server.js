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
const { yf: yahooFinance, historicalCompat } = require('./lib/yfCompat');
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');
const axios      = require('axios');
const Anthropic  = require('@anthropic-ai/sdk');
const https      = require('https'); // keep-alive agent
const ensembleRoutes = require('./routes/ensemble');
const UserProfile = require('./models/UserProfile');

// --- 1m technical advice helpers (no new npm deps) ---
const MS = 60 * 1000;
function sma(arr, n) {
  if (!Array.isArray(arr) || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}
function std(arr, n) {
  const m = sma(arr, n);
  if (m == null) return null;
  let v = 0;
  for (let i = arr.length - n; i < arr.length; i++) v += (arr[i] - m) ** 2;
  return Math.sqrt(v / n);
}
function ema(prevEma, price, k) {
  return prevEma == null ? price : prevEma + k * (price - prevEma);
}
function macdSeries(closes, fast=12, slow=26, sig=9) {
  const kFast = 2 / (fast + 1), kSlow = 2 / (slow + 1), kSig = 2 / (sig + 1);
  let eFast=null, eSlow=null, macd=[], signal=null, hist=[];
  for (const p of closes) {
    eFast = ema(eFast, p, kFast);
    eSlow = ema(eSlow, p, kSlow);
    const line = (eFast??0) - (eSlow??0);
    macd.push(line);
    signal = ema(signal, line, kSig);
    hist.push(line - (signal??0));
  }
  return { macd, signal, hist };
}
function stochastic(closes, highs, lows, kLen=14, dLen=3) {
  const k = [];
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - kLen + 1);
    const h = Math.max(...highs.slice(start, i + 1));
    const l = Math.min(...lows.slice(start, i + 1));
    k.push(h === l ? 50 : ((closes[i] - l) / (h - l)) * 100);
  }
  const d = [];
  for (let i = 0; i < k.length; i++) {
    const start = Math.max(0, i - dLen + 1);
    d.push(k.slice(start, i + 1).reduce((a,b)=>a+b,0) / (i - start + 1));
  }
  return { k, d };
}
function rsiSeries(closes, n=14) {
  const rsis = new Array(closes.length).fill(50);
  let ag=0, al=0; let init=false;
  for (let i=1;i<closes.length;i++){
    const ch = closes[i]-closes[i-1];
    const g = Math.max(ch,0), l = Math.max(-ch,0);
    if (i<=n){ ag+=g; al+=l; if(i===n){ ag/=n; al/=n; init=true; } }
    else { ag = (ag*(n-1)+g)/n; al=(al*(n-1)+l)/n; }
    if (init){ const rs = ag/(al||1e-9); rsis[i] = 100 - 100/(1+rs); }
  }
  return rsis;
}
function vwapFromMinute(candles) {
  let pv=0, tv=0;
  for (const c of candles) {
    const price = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    pv += price * vol; tv += vol;
  }
  return tv ? pv/tv : candles.at(-1)?.close ?? null;
}


const { getFundamentals } = require('./services/FundamentalsService');
const { getTechnical, getTechnicalForUser } = require('./services/TechnicalService');
const { getIntradayIndicators } = require('./services/IntradayService'); 
const analyzeRouter      = require('./routes/analyze');
const userProfileRoutes  = require('./routes/userProfileRoutes');
const advisorRouter = require('./routes/advisorRoutes');
const RSSParser = require('rss-parser');
const Sentiment = require('sentiment');
const rssParser = new RSSParser();
const sentiment = new Sentiment();
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const pdfParse  = require('pdf-parse');
const chokidar  = require('chokidar');
const RESEARCH_DIR = path.join(__dirname, '..', 'research'); // your folder outside backend

const cron = require('node-cron');
const DISABLE_BG = process.env.DISABLE_BACKGROUND_JOBS === '1';
const sciV1 = require('./services/sciV1Engine');
const modelPath = path.join(__dirname, 'model', 'sci_v1_regression.json');
sciV1.loadModelFromDisk(modelPath);
const SCI = require('./services/sci-formula-engine');
const sciCombiner = require('./services/sciCombiner');


// ---- Firebase Admin init (uses GOOGLE_SERVICE_ACCOUNT_KEY from env) ----
const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
if (!raw) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_KEY env var');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (_) {
  try {
    serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e2) {
    console.error('GOOGLE_SERVICE_ACCOUNT_KEY invalid (raw or base64):', e2.message);
    process.exit(1);
  }
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}



// ---- Express app ----
const app = express();
// set JSON body limit explicitly
app.use(express.json({ limit: '1mb' }));

// ─── CORS (single global config, hardened) ─────────────────────────────────────
app.set('trust proxy', 1); // required behind Render's proxy

const ALLOWLIST = new Set([
  'https://sci-investments.web.app',
  'https://sci-investments.firebaseapp.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]);

// add Vary: Origin so caches don't poison responses
app.use((req, res, next) => { res.setHeader('Vary', 'Origin'); next(); });

app.use('/api/formula3', require('./routes/formula3-symbol'));


const corsOptionsDelegate = (req, cb) => {
  const origin = req.headers.origin;
  const allowed = !origin || ALLOWLIST.has(origin);
  cb(null, {
    origin: allowed ? origin : false,     // echo the exact allowed origin
    credentials: true,
    methods: ['GET','POST','OPTIONS'],
    // 🔒 removed 'x-user-id'
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
    // 🔒 removed 'x-user-id'
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,x-user-id');
  }
  res.setHeader('Access-Control-Max-Age', '600');
  return res.sendStatus(204);
});
app.use(express.static(path.join(__dirname, "../public")));


// After your other routes:
app.use('/api/formula3', require('./routes/formula3'));


// put this helper near the top of server.js (or above the route)
function normalizeOnboarding(a = {}) {
  const n = { ...a };

  // Map portfolio buckets → representative numbers
  const psMap = {
    '<10K':       5_000,
    '10K-50K':    30_000,
    '50K-200K':   125_000,
    '200K+':      250_000
  };
  if (typeof a.portfolioSize === 'string') {
    if (psMap[a.portfolioSize]) {
      n.portfolioSizeBucket = a.portfolioSize;  // keep the chosen bucket (string)
      n.portfolioSize = psMap[a.portfolioSize]; // store a Number for the schema
    } else {
      // fall back: strip non-digits like "$" and "K" and try to parse
      const val = Number(String(a.portfolioSize).replace(/[^\d.]/g, ''));
      n.portfolioSize = Number.isFinite(val) ? val : null;
    }
  }

  // Make sure numeric fields are actually numbers
  const toNum = (x) => (x === '' || x == null ? null : Number(x));
  n.currentAge   = toNum(a.currentAge);
  n.retireAge    = toNum(a.retireAge);
  n.retireIncome = toNum(a.retireIncome);

  // % of income to invest: "<10%" → 10, "10-25%" → 10 (use first number)
  if (typeof a.investPct === 'string') {
    const m = a.investPct.match(/(\d+(\.\d+)?)/);
    if (m) n.investPct = Number(m[1]);
    n.investPctBucket = a.investPct; // keep the original label too
  }

  return n;
}

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

// ─── Security headers & Compression ─────────────────────────────────────────────────────────────
const helmet = require('helmet');
const compression = require('compression');
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }}));
app.use(compression());

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

// Anthropic client (lazy-init so missing key doesn't crash startup)
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

async function callChatServiceAdaptive({ system, messages }) {
  const safeMsgs   = trimMessages(messages || [], 12, 1500);
  const safeSystem = String(system || '').slice(0, 8000);

  // A) Anthropic Claude (preferred — structured, fast, follows formatting rules)
  const anthropic = getAnthropic();
  if (anthropic) {
    try {
      const userMsgs = safeMsgs.filter(m => m.role !== 'system');
      const response = await anthropic.messages.create({
        model:      process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system:     safeSystem,
        messages:   userMsgs.length ? userMsgs : [{ role: 'user', content: 'Hello' }],
      });
      const text = response?.content?.[0]?.text?.trim();
      if (text) return text;
    } catch (e) {
      console.warn('[Chat] Anthropic error:', e.message);
    }
  }

  // B) Legacy external service fallback
  if (!CHAT_SERVICE_URL) return '';
  const packed = [{ role: 'system', content: safeSystem }, ...safeMsgs];
  const opts   = { timeout: 20000 };
  try {
    const rA = await axios.post(CHAT_SERVICE_URL, { messages: packed }, opts);
    const tA = normalizeChatResponse(rA.data);
    if (tA) return tA;
  } catch (e) {
    console.warn('[Chat] Legacy A error:', e.message);
  }
  try {
    const prompt = renderPromptFromMessages(safeSystem, safeMsgs);
    const rB = await axios.post(CHAT_SERVICE_URL, { prompt }, opts);
    const tB = normalizeChatResponse(rB.data);
    if (tB) return tB;
  } catch (e) {
    console.warn('[Chat] Legacy B error:', e.message);
  }

  return '';
}

// create a keep-alive agent for Yahoo requests
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

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
    const feed = await rssParser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(symbol)}`);
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

// --- Helper: get user profile from auth header (no x-user-id)
async function getUserProfile(req) {
  try {
    // prefer req.user populated by authenticate(); otherwise verify Bearer softly
    if (req.user?.userId) {
      return await UserProfile.findOne({ userId: req.user.userId }).lean();
    }
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) {
      const idToken = header.split(' ')[1];
      const decoded = await admin.auth().verifyIdToken(idToken);
      return await UserProfile.findOne({ userId: decoded.uid }).lean();
    }
    return null;
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
Fundamentals: ${JSON.stringify(techNorm ? {
  valuation: fundamentals?.valuation, rating: fundamentals?.rating, weaknesses: fundamentals?.weaknesses
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
      const payload  = normalizeOnboarding(answers);

      // 1) Save all answers into your UserProfile collection
      await UserProfile.findOneAndUpdate(
        { userId },
        { userId, ...payload },
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
});

// ─── ROUTES MOUNT ──────────────────────────────────────────────────────────────
app.use('/api', analyzeRouter);
app.use('/api', userProfileRoutes);     // uses the same authenticate() inside
app.use('/api', advisorRouter);


/* extras */
const crypto      = require("crypto");
const fetchNative = require("node-fetch");
const cheerio     = require("cheerio");

/*──────────────────────────────────────────
|  TIME-SERIES CONFIG                      |
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
|  Testing Route                           |
└──────────────────────────────────────────*/

app.get('/api/model/shortterm-at/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase().trim();
    const asOfStr = String(req.query.asOf || '').slice(0, 10); // YYYY-MM-DD
    if (!symbol || !asOfStr || !/^\d{4}-\d{2}-\d{2}$/.test(asOfStr)) {
      return res.status(400).json({ error: 'Provide ?asOf=YYYY-MM-DD' });
    }

    // end = asOf at 00:00 local (exclusive in Yahoo query, so add 1 day)
    const asOf = new Date(asOfStr + 'T00:00:00');
    const period2 = new Date(asOf); period2.setDate(period2.getDate() + 1);
    const period1 = new Date(asOf); period1.setDate(period1.getDate() - 420); // ~20 months

    // Fetch only history available *up to asOf*
    const candles = await yahooFinance.historical(symbol, {
      period1,
      period2,
      interval: '1d',
    });

    if (!Array.isArray(candles) || candles.length < 60) {
      return res.status(422).json({ error: 'Not enough history before asOf' });
    }

    // ===== IMPORTANT =====
    // Reuse your live model’s logic here. If your current /api/model/shortterm
    // already builds features off `candles` and returns { pUp, magnitudePct },
    // move that logic into a small function and call it here.
    //
    // For now, this fallback uses a simple technical blend so the endpoint works
    // immediately; replace this block with your live model calculation.

    const closes = candles.map(c => Number(c.close));
    const last = closes.at(-1);
    const prev = closes.at(-2);

    // Minimal features (replace with your model):
    const rsi14 = (() => {
      const gains = [], losses = [];
      for (let i = 1; i < closes.length; i++) {
        const ch = closes[i] - closes[i - 1];
        gains.push(Math.max(ch, 0));
        losses.push(Math.max(-ch, 0));
      }
      const n = 14;
      if (gains.length < n) return 50;
      let ag = gains.slice(0, n).reduce((a,b)=>a+b,0)/n;
      let al = losses.slice(0, n).reduce((a,b)=>a+b,0)/n;
      for (let i = n; i < gains.length; i++) {
        ag = (ag*(n-1) + gains[i]) / n;
        al = (al*(n-1) + losses[i]) / n;
      }
      const rs = ag / (al || 1e-9);
      return 100 - 100/(1+rs);
    })();

    // Very small heuristic: higher RSI → higher pUp; include last return sign
    const ret = (last - prev) / prev;
    const pUp = Math.max(0.01, Math.min(0.99, 0.45 + (rsi14 - 50) * 0.006 + Math.sign(ret)*0.03));
    const magnitudePct = Math.min(4, Math.max(0.2, Math.abs(ret) * 100 * 1.2));

    return res.json({ pUp, magnitudePct, asOf: asOfStr, usedCandles: candles.length });
  } catch (err) {
    console.error('shortterm-at error', err);
    res.status(500).json({ error: 'shortterm-at failed' });
  }
});


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
if (process.env.NODE_ENV !== 'production') {
  mongoose.set('debug', true);
}
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET required in production');
}

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
const FORECAST_CACHE_TTL = 24*60*60*1000; // 24 h

const stockDataCache={};
const CACHE_TTL=60*60*1000;               // 60 min (was 15)

/*──────────────────────────────────────────
|  Yahoo fetch wrapper                     |
└──────────────────────────────────────────*/
const requestOptions = {
  headers: { "User-Agent": "Mozilla/5.0" },
  redirect: "follow",
  agent: keepAliveAgent, // keep-alive for speed
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
|  Time-series from cached CSV             |
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
  // conservative pattern; relax if your symbols.json includes . or -
  if (!/^[A-Z]{1,5}$/.test(sym)) return false;
  return symbolsList.some(x => (typeof x === 'string' ? x : x.symbol) === sym);
}

/*──────────────────────────────────────────
|  Rate-limits                             |
└──────────────────────────────────────────*/
const stockCheckerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});
app.use("/api/check-stock", stockCheckerLimiter);

const findStockLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});
app.use(['/api/sci/score', '/api/sci/train', '/api/intraday', '/api/stock-history', '/api/sci/chart'], heavyLimiter);

// put near other limiters
const communityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});
app.use('/api/community-posts', communityLimiter);

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

app.get('/api/me/profile', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(200).json(null);

    const profile = await UserProfile.findOne({ userId }).lean();
    return res.json(profile || null);
  } catch (err) {
    console.error('GET /api/me/profile failed:', err);
    return res.status(500).json({ error: 'Failed to load profile' });
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
    let { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ message: "symbol required." });

    const upper = String(symbol).toUpperCase().trim();

    const stock = await fetchStockData(upper);
    if (!stock || !stock.price) {
      return res.status(404).json({ message: "Stock not found or data unavailable." });
    }

    const priceData = stock.price || {};
    // Kick off technical analysis in parallel with the rest of the route
    const techPromise = getTechnical(upper).catch(() => null);
    const summary = stock.summaryDetail || {};
    const finData = stock.financialData || {};
    const profile = stock.assetProfile || {};

    const currentPrice = priceData.regularMarketPrice ?? null;
    const volume = priceData.regularMarketVolume ?? null;
    const avgVolume =
      summary.averageDailyVolume3Month ??
      summary.averageVolume ??
      null;

    const marketCap = priceData.marketCap ?? summary.marketCap ?? null;
    const bid = summary.bid ?? priceData.bid ?? null;
    const ask = summary.ask ?? priceData.ask ?? null;

    function num(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function pct(v) {
      const n = num(v);
      return n == null ? null : n * 100;
    }

    function addFinding(arr, section, stat, value, meaning, result, impact) {
      arr.push({ section, stat, value, meaning, result, impact });
    }

    function finalSuggestion(goods, bads) {
      if (goods > bads) return "Buy";
      if (bads > goods) return "Stay away / Don’t buy";
      return "Neutral / needs more analysis";
    }

    const findings = [];
    let goods = 0;
    let bads = 0;
    let neutrals = 0;

    function record(section, stat, value, meaning, result) {
      let impact = "neutral";
      if (result === "good") {
        goods++;
        impact = "good";
      } else if (result === "bad") {
        bads++;
        impact = "bad";
      } else {
        neutrals++;
      }
      addFinding(findings, section, stat, value, meaning, result, impact);
    }

    // 1. Liquidity / Tradability Check from PDF
    const spread = bid != null && ask != null ? ask - bid : null;
    const spreadPct = spread != null && currentPrice ? (spread / currentPrice) * 100 : null;

    record(
      "Liquidity / Tradability",
      "Bid-ask spread",
      spreadPct == null ? "Unavailable" : `${spreadPct.toFixed(2)}%`,
      "A spread below 0.5% of the stock price indicates sufficient liquidity for safe entry and exit.",
      spreadPct == null ? "neutral" : spreadPct < 0.5 ? "good" : "bad"
    );

    record(
      "Liquidity / Tradability",
      "Trading volume",
      volume == null ? "Unavailable" : volume,
      "The SCI framework only analyses stocks with at least 500,000 shares traded per day to ensure tradability.",
      volume == null ? "neutral" : volume > 500000 ? "good" : "bad"
    );

    record(
      "Liquidity / Tradability",
      "Market cap",
      marketCap == null ? "Unavailable" : marketCap,
      "The SCI framework filters for companies above $300M market cap to avoid micro-cap liquidity risk.",
      marketCap == null ? "neutral" : marketCap > 300000000 ? "good" : "bad"
    );

    record(
      "Liquidity / Tradability",
      "Float-adjusted volume",
      "Unavailable",
      "Float-adjusted volume above 15 million confirms institutional-grade liquidity. This data point is not available from the current source.",
      "neutral"
    );

    // 2. Volume comparative %
    let compVol = null;
    if (volume != null && avgVolume != null && avgVolume !== 0) {
      compVol = ((volume / avgVolume) - 1) * 100;
    }

    record(
      "Volume",
      "Comparative volume %",
      compVol == null ? "Unavailable" : `${compVol.toFixed(2)}%`,
      "Formula: [(today volume / average volume) - 1] × 100%. Higher volume can confirm participation, but spikes late in a move can mean exhaustion.",
      compVol == null ? "neutral" : compVol >= 0 ? "good" : "bad"
    );

    // 3. Sentiment comparative %
    let news = { averageSentiment: 0, topStories: [] };
    try {
      const feed = await withTimeout(
        rssParser.parseURL(`https://news.google.com/rss/search?q=${encodeURIComponent(upper)}`),
        3000
      );
      const items = (feed.items || []).slice(0, 5).map(i => {
        const snippet = (i.contentSnippet || i.title || "").slice(0, 200);
        return { title: i.title, link: i.link, snippet };
      });
      const scores = items.map(x => sentiment.analyze(x.snippet).score);
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      news = { averageSentiment: avg, topStories: items };
    } catch {}

    record(
      "Sentiment",
      "Average sentiment score",
      news.averageSentiment,
      "A positive news sentiment score is bullish. Negative sentiment can indicate near-term headwinds.",
      news.averageSentiment > 0 ? "good" : news.averageSentiment < 0 ? "bad" : "neutral"
    );

    // 4. SCI V1 z-score / score engine using your existing service
    let sciScore = null;
    try {
      const period2 = new Date();
      const period1 = new Date();
      period1.setFullYear(period1.getFullYear() - 2);

      const rows = await historicalCompat(upper, {
        period1: period1.toISOString().slice(0, 10),
        period2: period2.toISOString().slice(0, 10),
        interval: "1d"
      });

      const cleanRows = (rows || [])
        .map(r => ({
          date: r.date,
          open: num(r.open),
          high: num(r.high),
          low: num(r.low),
          close: num(r.close),
          volume: num(r.volume) || 0
        }))
        .filter(r =>
          r.open != null &&
          r.high != null &&
          r.low != null &&
          r.close != null
        )
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      if (cleanRows.length >= 40) {
        sciScore = sciV1.scoreWithRows(cleanRows);

        const final = sciScore?.decision?.final || "Neutral";
        const score = sciScore?.decision?.score ?? 0;
        const pUp = sciScore?.probability?.pUp ?? 0.5;
        const magnitude = sciScore?.probability?.magnitude ?? 0;

        record(
          "SCI Score",
          "Composite z-score result",
          `${final}, score ${score.toFixed(3)}`,
          "The SCI z-score engine compares current technical conditions against historical distributions to estimate directional bias.",
          final === "Up" ? "good" : final === "Down" ? "bad" : "neutral"
        );

        record(
          "SCI Score",
          "Probability up",
          `${(pUp * 100).toFixed(1)}%`,
          "This estimates the historical chance of an upward next move from the current SCI score setup.",
          pUp > 0.5 ? "good" : pUp < 0.5 ? "bad" : "neutral"
        );

        record(
          "SCI Score",
          "Expected magnitude",
          `${(magnitude * 100).toFixed(2)}%`,
          "This estimates the expected move size using volatility and conviction.",
          "neutral"
        );
      } else {
        record(
          "SCI Score",
          "Historical rows",
          cleanRows.length,
          "Insufficient historical data to run the SCI z-score engine. At least 40 trading days of history are required.",
          "neutral"
        );
      }
    } catch (e) {
      record(
        "SCI Score",
        "SCI score engine",
        "Unavailable",
        `SCI engine could not run: ${e.message}`,
        "neutral"
      );
    }

    // 5. Ticker volatility category
    const atrPct =
      sciScore?.indicators?.atrPct != null
        ? sciScore.indicators.atrPct * 100
        : null;

    let tickerVolCategory = "Unavailable";
    let tickerVolResult = "neutral";
    if (atrPct != null) {
      if (atrPct <= 1) {
        tickerVolCategory = "Low / normal";
        tickerVolResult = "good";
      } else if (atrPct <= 3) {
        tickerVolCategory = "High";
        tickerVolResult = "neutral";
      } else {
        tickerVolCategory = "Very high";
        tickerVolResult = "bad";
      }
    }

    record(
      "Volatility",
      "Ticker volatility",
      atrPct == null ? "Unavailable" : `${atrPct.toFixed(2)}% ATR`,
      "High ATR-based volatility increases risk and can reduce signal reliability. Low volatility is preferred for cleaner entries.",
      tickerVolResult
    );

    // 6. Valuation / financial model checks from available fields
    const evToEbitda = summary.enterpriseToEbitda ?? null;
    if (evToEbitda != null) {
      let result = "neutral";
      let meaning = "EV/EBITDA below 10 may indicate undervaluation; negative means the business is loss-making; above 15 suggests premium or high-growth pricing.";
      if (evToEbitda < 0) result = "bad";
      else if (evToEbitda < 10) result = "good";
      else if (evToEbitda > 15) result = "bad";

      record(
        "Financial Models",
        "EV/EBITDA",
        evToEbitda,
        meaning,
        result
      );
    } else {
      record(
        "Financial Models",
        "EV/EBITDA",
        "Unavailable",
        "EV/EBITDA is a key comparable valuation multiple in the SCI framework. Data not available for this ticker.",
        "neutral"
      );
    }

    const revenueGrowth = pct(finData.revenueGrowth);
    if (revenueGrowth != null) {
      let result = "neutral";
      if (revenueGrowth > 20) result = "bad";
      else if (revenueGrowth >= 5 && revenueGrowth <= 15) result = "good";
      else if (revenueGrowth < 2) result = "bad";

      record(
        "Financial Models",
        "Revenue growth",
        `${revenueGrowth.toFixed(2)}%`,
        "SCI target range is 5–15% annual revenue growth — steady and sustainable. Below 2% signals stagnation; above 20% may indicate early-stage risk.",
        result
      );
    } else {
      record(
        "Financial Models",
        "Revenue growth / CAGR",
        "Unavailable",
        "Multi-year revenue CAGR data is not available from the current source. Full historical statements would be needed for a complete assessment.",
        "neutral"
      );
    }

    const earningsGrowth = pct(finData.earningsGrowth);
    if (earningsGrowth != null) {
      let result = "neutral";
      if (earningsGrowth < 0) result = "bad";
      else if (earningsGrowth >= 5 && earningsGrowth < 10) result = "good";
      else if (earningsGrowth >= 10) result = "good";
      else if (earningsGrowth > 0 && earningsGrowth < 5) result = "neutral";

      record(
        "Financial Models",
        "EPS / earnings growth",
        `${earningsGrowth.toFixed(2)}%`,
        "EPS growth scale: below 0% is poor, 0–5% weak, 5–10% acceptable, 10–15% good, 15–20% strong, above 20% exceptional.",
        result
      );
    } else {
      record(
        "Financial Models",
        "EPS / earnings growth",
        "Unavailable",
        "EPS growth data is not available from the current source. Multi-year EPS CAGR is used to detect dilution and real per-share growth.",
        "neutral"
      );
    }

    record(
      "Financial Models",
      "DCF / WACC / Comps",
      "Unavailable",
      "DCF, WACC stress testing, and comparable-company analysis require full financial statements, peer groups, and FCF forecasts. These cannot be reliably computed from live quote data alone.",
      "neutral"
    );

    // ── Profit & Margins ─────────────────────────────────────────────
    const grossMargin    = pct(finData.grossMargins);
    const operatingMargin = pct(finData.operatingMargins);
    const netMargin      = pct(finData.profitMargins);
    const roa            = pct(finData.returnOnAssets);
    const roe            = pct(finData.returnOnEquity);

    if (grossMargin != null) {
      record(
        "Profit & Margins", "Gross margin", `${grossMargin.toFixed(1)}%`,
        grossMargin > 40
          ? `At ${grossMargin.toFixed(1)}%, the company keeps a large portion of each sales dollar after production costs. Strong gross margins signal pricing power and operational efficiency.`
          : grossMargin > 20
          ? `At ${grossMargin.toFixed(1)}%, gross margins are moderate — acceptable but not exceptional. Compare to competitors in the same industry to judge.`
          : `At ${grossMargin.toFixed(1)}%, gross margins are thin. There is very little buffer between revenue and the cost of making the product.`,
        grossMargin > 40 ? "good" : grossMargin > 20 ? "neutral" : "bad"
      );
    } else {
      record("Profit & Margins", "Gross margin", "Unavailable", "Gross margin data not available from this data source.", "neutral");
    }

    if (netMargin != null) {
      record(
        "Profit & Margins", "Net margin", `${netMargin.toFixed(1)}%`,
        netMargin > 15
          ? `At ${netMargin.toFixed(1)}%, the company is highly profitable — it keeps over 15 cents of profit for every dollar earned.`
          : netMargin > 5
          ? `At ${netMargin.toFixed(1)}%, the company is moderately profitable. Positive margins mean the business earns real money, not just revenue.`
          : netMargin > 0
          ? `At ${netMargin.toFixed(1)}%, net margins are very thin. A small revenue dip could push this business into losses.`
          : `Net margin is negative (${netMargin.toFixed(1)}%) — the company is losing money. Per your framework, negative net margin is a red flag.`,
        netMargin > 5 ? "good" : netMargin > 0 ? "neutral" : "bad"
      );
    } else {
      record("Profit & Margins", "Net margin", "Unavailable", "Net margin data not available.", "neutral");
    }

    if (roa != null) {
      record(
        "Profit & Margins", "Return on Assets (ROA)", `${roa.toFixed(1)}%`,
        roa > 5
          ? `ROA of ${roa.toFixed(1)}% means the company generates strong returns from what it owns — a sign of efficient management.`
          : roa > 0
          ? `ROA of ${roa.toFixed(1)}% is positive but modest. The company earns on its assets but could be more efficient.`
          : `ROA is negative — per your framework, this is a red flag indicating the company destroys value on its assets.`,
        roa > 5 ? "good" : roa > 0 ? "neutral" : "bad"
      );
    }

    if (roe != null) {
      record(
        "Profit & Margins", "Return on Equity (ROE)", `${roe.toFixed(1)}%`,
        roe > 15
          ? `ROE of ${roe.toFixed(1)}% means shareholders are getting excellent returns on their invested equity — a hallmark of quality companies.`
          : roe > 0
          ? `ROE of ${roe.toFixed(1)}% is positive — the company generates some return for shareholders, but has room to improve.`
          : `ROE is negative — the company is destroying shareholder value.`,
        roe > 15 ? "good" : roe > 0 ? "neutral" : "bad"
      );
    }

    // ── Debt & Safety ────────────────────────────────────────────────
    const debtToEquity = num(finData.debtToEquity);
    const currentRatioVal = num(finData.currentRatio);

    if (debtToEquity != null) {
      record(
        "Debt & Safety", "Debt-to-equity ratio", debtToEquity.toFixed(2),
        debtToEquity < 0.5
          ? `D/E of ${debtToEquity.toFixed(2)} — very little debt relative to equity. This company is financially conservative and resilient to downturns.`
          : debtToEquity < 1.5
          ? `D/E of ${debtToEquity.toFixed(2)} is a manageable debt load — moderate leverage, within normal range for most industries.`
          : debtToEquity < 3
          ? `D/E of ${debtToEquity.toFixed(2)} indicates high leverage. Per your framework, high debt increases risk especially in rising interest rate environments.`
          : `D/E of ${debtToEquity.toFixed(2)} is very high — your framework flags this as a high-leverage warning. Companies burning through loans to stay afloat may look attractive but carry serious risk.`,
        debtToEquity < 1.5 ? "good" : debtToEquity < 3 ? "neutral" : "bad"
      );
    } else {
      record("Debt & Safety", "Debt-to-equity ratio", "Unavailable", "Debt ratio data not available from this source.", "neutral");
    }

    if (currentRatioVal != null) {
      record(
        "Debt & Safety", "Current ratio", currentRatioVal.toFixed(2),
        currentRatioVal > 2
          ? `Current ratio of ${currentRatioVal.toFixed(2)} means the company has ${currentRatioVal.toFixed(1)}x more short-term assets than short-term liabilities — very liquid and able to cover near-term obligations easily.`
          : currentRatioVal > 1
          ? `Current ratio of ${currentRatioVal.toFixed(2)} means the company can cover short-term debts, but with limited buffer. Acceptable, not comfortable.`
          : `Current ratio below 1 (${currentRatioVal.toFixed(2)}) is a warning sign — the company has more near-term debt than short-term assets. Liquidity risk.`,
        currentRatioVal > 1.5 ? "good" : currentRatioVal > 1 ? "neutral" : "bad"
      );
    } else {
      record("Debt & Safety", "Current ratio", "Unavailable", "Current ratio data not available.", "neutral");
    }

    // ── Additional Valuation ─────────────────────────────────────────
    const trailingPE  = num(stock.summaryDetail?.trailingPE ?? stock.defaultKeyStatistics?.trailingPE);
    const priceToBook = num(stock.summaryDetail?.priceToBook ?? stock.defaultKeyStatistics?.priceToBook);

    if (trailingPE != null) {
      let peResult = "neutral", peMeaning;
      if (trailingPE < 0) {
        peResult = "bad";
        peMeaning = `P/E is negative — the company is not currently profitable. Stay away per your framework.`;
      } else if (trailingPE < 15) {
        peResult = "good";
        peMeaning = `P/E of ${trailingPE.toFixed(1)}x is low — the stock may be undervalued relative to earnings. Verify it is not a value trap (check the trend in earnings).`;
      } else if (trailingPE <= 25) {
        peResult = "neutral";
        peMeaning = `P/E of ${trailingPE.toFixed(1)}x is in a fair range for most established companies.`;
      } else {
        peResult = "bad";
        peMeaning = `P/E of ${trailingPE.toFixed(1)}x is elevated — the market is pricing in high growth. Any earnings disappointment could cause a sharp correction.`;
      }
      record("Valuation", "P/E ratio (trailing 12 months)", `${trailingPE.toFixed(1)}x`, peMeaning, peResult);
    }

    if (priceToBook != null) {
      record(
        "Valuation", "Price-to-book ratio", `${priceToBook.toFixed(2)}x`,
        priceToBook < 1
          ? `P/B below 1 (${priceToBook.toFixed(2)}x) means you are buying assets for less than their book value — potentially undervalued. Verify why the market discounts it.`
          : priceToBook < 3
          ? `P/B of ${priceToBook.toFixed(2)}x is reasonable — a small premium to book value, normal for profitable companies.`
          : `P/B of ${priceToBook.toFixed(2)}x is elevated — the market prices in significant intangibles (brand, IP, growth). Justified for quality companies, risky if growth slows.`,
        priceToBook < 3 ? "good" : priceToBook < 5 ? "neutral" : "bad"
      );
    }

    // ── Technical Signals (await getTechnical result) ─────────────────
    const tech       = await techPromise;
    const ind        = tech?.indicators || {};
    const techLevels = tech?.levels     || {};
    const techTrend  = tech?.trend      || "sideways";

    if (ind.RSI14 != null) {
      let rsiResult = "neutral", rsiMsg;
      const r = ind.RSI14;
      if (r < 30) {
        rsiResult = "good";
        rsiMsg = `RSI is at ${r.toFixed(1)} — the stock is oversold. Sellers have exhausted themselves and a bounce is statistically likely. Your framework treats this as a potential entry zone.`;
      } else if (r < 45) {
        rsiResult = "neutral";
        rsiMsg = `RSI at ${r.toFixed(1)} is in the lower neutral zone — momentum is weak but not extreme. Not yet a buying signal by itself.`;
      } else if (r <= 60) {
        rsiResult = "good";
        rsiMsg = `RSI at ${r.toFixed(1)} is healthy — momentum is positive without being overbought. This is the sweet spot for a continuation move in your framework.`;
      } else if (r <= 70) {
        rsiResult = "neutral";
        rsiMsg = `RSI at ${r.toFixed(1)} is elevated — momentum is strong but approaching overbought. Be cautious about chasing the move.`;
      } else {
        rsiResult = "bad";
        rsiMsg = `RSI above 70 (${r.toFixed(1)}) — the stock is overbought. A pullback or consolidation is statistically likely. Your framework reduces signal reliability here.`;
      }
      record("Technical Signals", "RSI 14 (momentum)", r.toFixed(1), rsiMsg, rsiResult);
    }

    if (ind.MACD) {
      const bullishMacd = ind.MACD.macd > ind.MACD.signal;
      record(
        "Technical Signals", "MACD signal",
        bullishMacd ? "Bullish" : "Bearish",
        bullishMacd
          ? `MACD line (${ind.MACD.macd.toFixed(3)}) is above the signal line (${ind.MACD.signal.toFixed(3)}) — short-term momentum is stronger than the longer-term baseline. A bullish signal per your framework.`
          : `MACD line (${ind.MACD.macd.toFixed(3)}) is below the signal line (${ind.MACD.signal.toFixed(3)}) — short-term momentum is weaker than the longer-term baseline. A bearish signal.`,
        bullishMacd ? "good" : "bad"
      );
    }

    if (techTrend) {
      let trendResult, trendMsg;
      if (techTrend === "uptrend") {
        trendResult = "good";
        trendMsg = `SMA 50 is above SMA 200 — a "Golden Cross". This confirms a long-term uptrend. Your framework says momentum strategies work best in trending markets with ADX > 25.`;
      } else if (techTrend === "downtrend") {
        trendResult = "bad";
        trendMsg = `SMA 50 is below SMA 200 — a "Death Cross". This confirms a long-term downtrend. Your framework says to be cautious and avoid momentum longs in this environment.`;
      } else {
        trendResult = "neutral";
        trendMsg = `Moving averages are close together — no clear trend. The market is sideways or transitioning. Your framework says to wait for a cleaner directional signal before committing.`;
      }
      record(
        "Technical Signals", "Long-term trend (SMA 50 vs SMA 200)",
        techTrend === "uptrend" ? "Uptrend — Golden Cross" : techTrend === "downtrend" ? "Downtrend — Death Cross" : "Sideways",
        trendMsg, trendResult
      );
    }

    if (ind.SMA50 != null && currentPrice != null) {
      const pctFromSMA50 = ((currentPrice - ind.SMA50) / ind.SMA50) * 100;
      const above = currentPrice > ind.SMA50;
      record(
        "Technical Signals", "Price vs SMA 50",
        `${above ? "+" : ""}${pctFromSMA50.toFixed(1)}% from $${ind.SMA50.toFixed(2)}`,
        above
          ? `Price is ${pctFromSMA50.toFixed(1)}% above its 50-day moving average ($${ind.SMA50.toFixed(2)}). Stocks trading above key moving averages tend to remain in an uptrend.`
          : `Price is ${Math.abs(pctFromSMA50).toFixed(1)}% below its 50-day moving average ($${ind.SMA50.toFixed(2)}). This indicates short-to-medium term weakness.`,
        above ? "good" : "bad"
      );
    }

    if (ind.BB_upper != null && ind.BB_lower != null && currentPrice != null) {
      const range  = ind.BB_upper - ind.BB_lower;
      const bbPos  = range > 0 ? (currentPrice - ind.BB_lower) / range : 0.5;
      let bbResult = "neutral", bbMsg;
      if (bbPos > 0.85) {
        bbResult = "bad";
        bbMsg = `Price is near the upper Bollinger Band ($${ind.BB_upper.toFixed(2)}) — statistically expensive relative to recent volatility. Your framework flags this as a potential sell zone.`;
      } else if (bbPos < 0.15) {
        bbResult = "good";
        bbMsg = `Price is near the lower Bollinger Band ($${ind.BB_lower.toFixed(2)}) — statistically cheap relative to recent volatility. A potential bounce zone per your framework.`;
      } else {
        bbResult = "neutral";
        bbMsg = `Price sits within the Bollinger Bands (upper: $${ind.BB_upper.toFixed(2)}, lower: $${ind.BB_lower.toFixed(2)}) — no extreme band signal. Momentum is not stretched.`;
      }
      record("Technical Signals", "Bollinger Band position", `${(bbPos * 100).toFixed(0)}% within bands`, bbMsg, bbResult);
    }

    // ── Support & Resistance ─────────────────────────────────────────
    if (techLevels.support != null && techLevels.resistance != null && currentPrice != null) {
      const distToSupport    = ((currentPrice - techLevels.support)    / currentPrice) * 100;
      const distToResistance = ((techLevels.resistance - currentPrice) / currentPrice) * 100;

      record(
        "Support & Resistance", "20-day support level", `$${techLevels.support.toFixed(2)}`,
        `Support at $${techLevels.support.toFixed(2)} is ${distToSupport.toFixed(1)}% below the current price. This is where buyers have historically stepped in. A good place to consider a stop loss — if price breaks below this level convincingly, the thesis has failed.`,
        distToSupport > 3 ? "good" : distToSupport > 1 ? "neutral" : "bad"
      );

      record(
        "Support & Resistance", "20-day resistance level", `$${techLevels.resistance.toFixed(2)}`,
        `Resistance at $${techLevels.resistance.toFixed(2)} is ${distToResistance.toFixed(1)}% above the current price. Price has struggled to break above this level. A confirmed breakout above it would be a strong bullish signal with target upside.`,
        distToResistance > 5 ? "good" : distToResistance > 2 ? "neutral" : "bad"
      );

      if (distToSupport > 0 && distToResistance > 0) {
        const riskReward = distToResistance / distToSupport;
        record(
          "Support & Resistance", "Implied risk/reward (S/R based)", `${riskReward.toFixed(2)}:1`,
          riskReward > 2
            ? `${distToResistance.toFixed(1)}% upside to resistance vs ${distToSupport.toFixed(1)}% risk to support = ${riskReward.toFixed(2)}:1 risk/reward. Your framework requires more upside than downside — this qualifies.`
            : riskReward > 1
            ? `${distToResistance.toFixed(1)}% upside vs ${distToSupport.toFixed(1)}% risk = ${riskReward.toFixed(2)}:1. Marginally positive but thin margin. Consider waiting for a better setup closer to support.`
            : `${distToResistance.toFixed(1)}% upside vs ${distToSupport.toFixed(1)}% risk = ${riskReward.toFixed(2)}:1. Unfavorable — the downside to support exceeds the upside to resistance. Your framework says skip this trade.`,
          riskReward > 2 ? "good" : riskReward > 1 ? "neutral" : "bad"
        );
      }
    }

    // 7. Regime detection
    const marketVol = null;
    record(
      "Regime Detection",
      "GMM / HMM / Hurst regime",
      "Unavailable",
      "Regime detection uses GMM, HMM, and the Hurst exponent to classify whether the market is trending or mean-reverting. These models are not yet computed on this route.",
      "neutral"
    );

    // 8. Risk management
    record(
      "Risk Management",
      "Risk per trade",
      "1–2% max portfolio risk",
      "The SCI framework mandates capping risk at 1–2% of total portfolio per trade to protect capital over the long run.",
      "neutral"
    );

    record(
      "Risk Management",
      "Risk/reward",
      "Needs user entry, stop, and target",
      "Every trade must offer more upside than downside. A risk/reward ratio above 1:1.5 is preferred. Requires a defined entry, stop loss, and price target.",
      "neutral"
    );

    const suggestion = finalSuggestion(goods, bads);

    return res.json({
      symbol: upper,
      name: priceData.longName || upper,
      industry: profile.industry || "Unknown",
      method: "SCI analysis method",
      source: "SCI PDF methodology",
      summary: {
        goods,
        bads,
        neutrals,
        overallSuggestion: suggestion,
        explanation:
          "The suggestion is based on your rule: if good findings are greater than bad findings, it is Buy; if bad findings are greater than good findings, it is Stay away / Don’t buy; if close or incomplete, it is Neutral."
      },
      metrics: {
        currentPrice,
        volume,
        avgVolume,
        marketCap,
        bid,
        ask,
        spreadPct,
        comparativeVolumePercent: compVol,
        sentimentScore: news.averageSentiment
      },
      sciScore,
      findings,
      news,
      levels: Object.keys(techLevels).length ? techLevels : null,
      technicalIndicators: Object.keys(ind).length ? ind : null,
      trend: techTrend || null
    });
  } catch (err) {
    console.error("SCI check-stock route error:", err);
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
  return 'auto';
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
You are SCI, a precise AI equity advisor. Your responses are rendered with markdown — use it.

FORMATTING RULES (follow exactly):
- Use ### for section titles: ### Snapshot, ### Core View, ### Action
- Use **bold** for key numbers, tickers, signals
- Use "- " bullet lines for lists of data points or reasons
- Keep total response under 180 words
- Never output raw JSON, code blocks, or unformatted walls of text

RESPONSE STRUCTURE:
### Snapshot
One sentence: [Ticker] at $[price], [52w position: near high/mid/low]. Analyst consensus: [Buy/Neutral/Avoid].

### Core View
- 2–3 bullet points from fundamentals/technicals/research

### Action
**[Buy / Hold / Avoid]** — one sentence rationale. Risk note aligned to profile.

DATA (use only this, never invent):
Intent: ${intent}
Profile: ${JSON.stringify(profile || {})}
Memory:  ${JSON.stringify(memory || {})}
Context: ${JSON.stringify(llmContext || {})}
`.trim();
    } else if (intent === 'portfolio_sizing' || intent === 'risk_policy') {
      system = `
You are SCI's portfolio coach. Responses rendered with markdown — use ### headers and **bold** for numbers.

### Framework
Explain position sizing in ≤3 bullet points using the user's profile numbers if available.

### Example
Show a round-number worked example.

Keep total response under 160 words.

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
You are SCI's stock scout. Responses are rendered with markdown.

### Ideas
List 2–3 picks as bullets: "- **TICK** $XX.XX — [one-line reason (probability/expected-return)]"
End with one line: "Ask me to deep-dive any of these."
Keep total under 120 words.

Profile: ${JSON.stringify(profile || {})}
Memory:  ${JSON.stringify(memory || {})}
Picks:   ${JSON.stringify(picksLite || [])}
`.trim();
    } else if (intent === 'education') {
      system = `
You are SCI's investing educator. Responses rendered with markdown.

### [Concept Name]
Explain in ≤3 bullet points using simple language.

### Example
One sentence mini-example.

### Watch Out
One caution/pitfall.

Keep total under 150 words.
Profile (adjust tone): ${JSON.stringify(profile || {})}
`.trim();
    } else if (intent === 'greet' || intent === 'other' || intent === 'macro' || intent === 'watchlist_update') {
      // friendly general assistant + quick capability summary; try to be helpful immediately
      const picks = await quickPicksForUser(profile).catch(() => []);
      const picksLite = picks.map(p => ({ symbol: p.symbol, expectedReturnPct: p.expectedReturnPct }));
      system = `
You are SCI, an AI financial assistant. Responses rendered with markdown.

Respond warmly in ≤120 words. If picks are available, mention 1–2 as "- **TICK** (+X% expected)" quick ideas.
Offer what you can do: analyze tickers, size positions, give ideas, explain concepts.

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
|  STOCK-HISTORY  –  daily candles         |
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

    const rows = await withTimeout(
      yahooFinance.historical(
        symbol,
        { period1: start, period2: end, interval: "1d" },
        { fetchOptions: requestOptions }
      ),
      8000
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
// SCI: build SCORE | MOVE | %CHANGE dataset for a symbol
// GET /api/sci/chart/:symbol?days=420&csv=1&save=1
// ────────────────────────────────────────────────────────────
app.get('/api/sci/chart/:symbol', async (req, res) => {
  try {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!isValidSymbol(sym)) return res.status(400).send('unknown symbol');

    const days = Math.max(120, Math.min(1200, Number(req.query.days) || 420));
    const rows = await stGetDaily(sym, days); // you already have this helper
    if (!rows || rows.length < 60) return res.status(422).send('not enough history');

    const n = rows.length;
    const close = rows.map(r => r.close);
    const open  = rows.map(r => r.open);
    const high  = rows.map(r => r.high);
    const low   = rows.map(r => r.low);
    const vol   = rows.map(r => r.volume);

    // --- vector indicators (compact, per-bar) ---
    const ret1 = Array(n).fill(NaN); // 1-day return
    const gap  = Array(n).fill(NaN); // open vs prior close
    const mom5 = Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      ret1[i] = (close[i] - close[i - 1]) / close[i - 1];
      gap[i]  = (open[i] / close[i - 1]) - 1;
    }
    for (let i = 5; i < n; i++) {
      mom5[i] = (close[i] / close[i - 5]) - 1;
    }

    function seriesRSI14(closes, p = 14) {
      const m = closes.length, out = Array(m).fill(NaN);
      if (m < p + 1) return out;
      let g = 0, l = 0;
      for (let i = 1; i <= p; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
      }
      g /= p; l /= p;
      out[p] = 100 - 100 / (1 + g / (l || 1e-9));
      for (let i = p + 1; i < m; i++) {
        const d = closes[i] - closes[i - 1];
        const gg = d > 0 ? d : 0, ll = d < 0 ? -d : 0;
        g = (g * (p - 1) + gg) / p;
        l = (l * (p - 1) + ll) / p;
        out[i] = 100 - 100 / (1 + g / (l || 1e-9));
      }
      return out;
    }

    function seriesATR14(rows, p = 14) {
      const m = rows.length, out = Array(m).fill(NaN);
      if (m < p + 1) return out;
      const TR = Array(m).fill(NaN);
      for (let i = 1; i < m; i++) {
        const h = rows[i].high, lw = rows[i].low, pc = rows[i - 1].close;
        TR[i] = Math.max(h - lw, Math.abs(h - pc), Math.abs(lw - pc));
      }
      out[p] = (TR.slice(1, p + 1).reduce((a, x) => a + x, 0)) / p;
      for (let i = p + 1; i < m; i++) out[i] = (out[i - 1] * (p - 1) + TR[i]) / p;
      return out;
    }

    function seriesPctB(closes, p = 20) {
      const m = closes.length, out = Array(m).fill(NaN);
      const q = [];
      for (let i = 0; i < m; i++) {
        q.push(closes[i]);
        if (q.length > p) q.shift();
        if (q.length < p) continue;
        const sma = q.reduce((a,b)=>a+b,0)/p;
        const std = Math.sqrt(q.reduce((s,x)=>s+(x-sma)**2,0)/p);
        const upper = sma + 2*std, lower = sma - 2*std;
        out[i] = (closes[i] - lower) / Math.max(upper - lower, 1e-9);
      }
      return out;
    }

    function seriesOBV(rows) {
      const out = Array(rows.length).fill(NaN);
      let v = 0;
      out[0] = 0;
      for (let i = 1; i < rows.length; i++) {
        const dir = Math.sign(rows[i].close - rows[i - 1].close);
        v += dir * rows[i].volume;
        out[i] = v;
      }
      return out;
    }

    const RSI14   = seriesRSI14(close, 14);
    const ATR14   = seriesATR14(rows, 14);
    const atrPct  = ATR14.map((a, i) => (Number.isFinite(a) && Number.isFinite(close[i])) ? a / close[i] : NaN);
    const pctB20  = seriesPctB(close, 20).map(x => Number.isFinite(x) ? (x - 0.5) * 2 : NaN); // center to ~0
    const OBV     = seriesOBV(rows);

    // --- robust rolling z-scores (median/MAD) ---
    const L = Math.min(252, Math.max(40, Math.floor(n * 0.6))); // sensible window
    const zRET1   = SCI.rollingRobustZ(ret1,  L);
    const zMOM5   = SCI.rollingRobustZ(mom5,  L);
    const zRSI14  = SCI.rollingRobustZ(RSI14, L);
    const zATRpct = SCI.rollingRobustZ(atrPct,L);
    const zGAP    = SCI.rollingRobustZ(gap,   L);
    const zVOL    = SCI.rollingRobustZ(vol,   L);
    const zOBV    = SCI.rollingRobustZ(OBV,   L);
    const zPctB   = SCI.rollingRobustZ(pctB20,L);

    // --- build composite score S with YOUR formula ---
    const Z = { zRET1, zMOM5, zRSI14, zATRpct, zGAP, zVOL, zOBV, zPctB };
    const S = SCI.buildCompositeScore(Z, (Zmap, t) => sciCombiner(Zmap, t));

    // --- format rows for chart ---
    const triples = SCI.toChartTriples(S, close);

    // optional CSV + save
    const asCSV = String(req.query.csv || '') === '1';
    const doSave = String(req.query.save || '') === '1';
    if (doSave) {
      const outDir = path.join(__dirname, 'output');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `SCI_${sym}_score_move_pct.csv`), SCI.rowsToCSV(triples));
    }

    if (asCSV) {
      res.setHeader('Content-Type', 'text/csv');
      return res.send(SCI.rowsToCSV(triples));
    }
    return res.json({ symbol: sym, rows: triples });
  } catch (e) {
    console.error('sci/chart:', e.message);
    res.status(500).json({ error: 'chart build failed' });
  }
});


// ────────────────────────────────────────────────────────────
// Intraday Indicators Endpoint (never hard-500 to the frontend)
// ────────────────────────────────────────────────────────────
app.get("/api/intraday/:symbol", async (req, res) => {
  const symbol = (req.params.symbol || "").toUpperCase();
  const opts = {
    interval: req.query.interval,
    range: req.query.range,
    from: req.query.from,
    to: req.query.to,
  };

  try {
    const data = await getIntradayIndicators(symbol, opts);
    return res.status(200).json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error(`intraday/${symbol}:`, err?.message || err);
    // ✅ degrade gracefully
    return res.status(200).json([]);
  }
});

/*──────────────────────────────────────────
|  Short-term expected move (T+1, daily)   |
|  Probability × Magnitude model           |
└──────────────────────────────────────────*/
const ST_EXPECTED_CACHE = new Map();
const ST_TTL_MS = 10 * 60 * 1000;

const stClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const stSigmoid = z => 1 / (1 + Math.exp(-z));

// fetch ~120 trading days of daily bars
async function stGetDaily(symbol, days = 120) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await withTimeout(
    yahooFinance.historical(
      symbol,
      { period1: start, period2: end, interval: "1d" },
      { fetchOptions: requestOptions }
    ),
    8000
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

  // --- features ---
  const mom5     = (closes[closes.length - 1] / closes[closes.length - 6]) - 1;
  const rangePct = (last.high - last.low) / last.close;
  const gapPct   = (last.open / closes[closes.length - 2]) - 1;

  const RSI      = stRSI14(closes, 14);
  const { hist: MACDh } = stMACD(closes);
  const { pctB } = stBBands(closes, 20);
  const ATR      = stATR14(rows, 14);
  const atrPct   = ATR ? ATR / last.close : 0.01;

  // volume/OBV z-scores
  const volZ = stZ(vols.slice(-60));
  const obvSeries = [];
  for (let i = rows.length - 60; i < rows.length; i++) {
    obvSeries.push(stOBV(rows.slice(0, i + 1)));
  }
  const obvZ = stZ(obvSeries);

  // --- normalize (tighter mom clamp) ---
  const mom5N = stClamp(mom5 / 0.03, -2, 2);
  const gapN  = stClamp(gapPct / 0.01, -3, 3);
  const rngN  = stClamp(rangePct / 0.03, 0, 3);
  const bbN   = (pctB != null) ? stClamp((pctB - 0.5) * 2, -2, 2) : 0;
  const volN  = stClamp(volZ, -3, 3);
  const obvN  = stClamp(obvZ, -3, 3);

  // RSI split: favor mid momentum; penalize overbought extremes (mean-revert next day)
  const rsiMid = (RSI != null) ? stClamp((RSI - 60) / 10, -2, 2) : 0;
  const rsiOb  = (RSI != null) ? Math.max(0, (RSI - 70) / 10) : 0;

  // MACD scaled by ATR
  const macdN = (MACDh != null && ATR) ? stClamp(MACDh / ATR, -3, 3) : 0;

  // --- linear blend (updated weights) ---
  let z =
      0.10
    + 0.30 * rsiMid
    - 0.60 * rsiOb
    + 0.30 * macdN
    + 0.40 * mom5N
    - 0.20 * gapN
    + 0.10 * bbN
    + 0.15 * volN
    + 0.10 * obvN
    - 0.20 * rngN;

  // Volatility penalty
  const ATR_MAX = Number(process.env.ST_ATR_MAX || 0.03);
  if (atrPct > ATR_MAX) z *= 0.5;

  // Temperature & clamp for calibration
  const TEMP   = Number(process.env.ST_TEMP || 1.5);
  const PMIN   = Number(process.env.ST_PMIN || 0.15);
  const PMAX   = Number(process.env.ST_PMAX || 0.85);
  let pUp = 1 / (1 + Math.exp(-(z / TEMP)));
  pUp = stClamp(pUp, PMIN, PMAX);

  // Magnitude (slightly gentler)
  const magnitude = stClamp(
    (atrPct || 0.01) * (1
      + 0.20 * Math.abs(volN)
      + 0.25 * Math.abs(macdN)
      + 0.15 * Math.abs(gapN)
      + 0.25 * Math.abs(mom5N)
    ),
    0.002, 0.08
  );

  const expectedReturn   = (2 * pUp - 1) * magnitude;
  const expectedIncrease = pUp * magnitude;

  const out = {
    pUp,
    magnitude,
    expectedReturn,
    expectedIncrease,
    diagnostics: { RSI, MACDh, pctB, atrPct, mom5, rangePct, gapPct, volZ, obvZ, TEMP, PMIN, PMAX }
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
        const profile = await getUserProfile(req); // may be null (no token)
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

app.use('/api/ensemble', ensembleRoutes);

/*──────────────────────────────────────────
|  14) Dashboard helper endpoints          |
└──────────────────────────────────────────*/

/* utility: split an array into chunks */
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* 1️⃣  MOST-TRADED POPULAR STOCKS  */
app.get("/api/popular-stocks*", async (_req, res) => {
  try {
    const popular = ["AAPL", "TSLA", "AMZN", "NVDA", "META", "GOOG", "MSFT"];
    const quotes = await Promise.all(
      popular.map((s) => fetchStockData(s).catch(() => null))
    );

    function quickSuggestion(d) {
      // Use Yahoo analyst consensus (recommendationMean: 1=StrongBuy, 5=StrongSell)
      const rec = d?.financialData?.recommendationMean ?? d?.summaryDetail?.recommendationMean;
      if (rec != null) {
        if (rec <= 2.0) return "Buy";
        if (rec >= 3.8) return "Stay Away";
        return "Neutral";
      }
      // Fallback: use 52w range position + day change
      const price  = d?.price?.regularMarketPrice;
      const hi52   = d?.price?.fiftyTwoWeekHigh ?? d?.summaryDetail?.fiftyTwoWeekHigh;
      const lo52   = d?.price?.fiftyTwoWeekLow  ?? d?.summaryDetail?.fiftyTwoWeekLow;
      const chgPct = d?.price?.regularMarketChangePercent;
      if (price && hi52 && lo52) {
        const pos = (price - lo52) / (hi52 - lo52); // 0=at low, 1=at high
        if (pos > 0.75 && chgPct < 0) return "Neutral"; // near high but falling
        if (pos < 0.30) return chgPct >= 0 ? "Buy" : "Stay Away";
        if (chgPct >= 0.01) return "Buy";
        if (chgPct <= -0.01) return "Neutral";
      }
      return "Neutral";
    }

    const rows = quotes
      .map((d, i) =>
        d && d.price
          ? {
              symbol: popular[i],
              name: d.price.longName || popular[i],
              price: d.price.regularMarketPrice || 0,
              volume: d.price.regularMarketVolume || 0,
              overallSuggestion: quickSuggestion(d),
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

/* 2️⃣  TOP-FORECASTED (first 200 tickers, batched) */
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
    console.error("top-forecasted:", e.message);
    return res.status(500).json({ forecasts: [] });
  }
});

/* 1.5️⃣  BEST-BUYS (short-term, probability-based) — cached + lighter */
app.get("/api/best-buys*", async (_req, res) => {
  try {
    if (BEST_BUYS_CACHE.data && (Date.now() - BEST_BUYS_CACHE.ts) < BEST_BUYS_TTL_MS) {
      return res.json({ picks: BEST_BUYS_CACHE.data });
    }

    const sample = symbolsList
      .slice(0, 120)
      .map(s => (typeof s === "string" ? s : s.symbol));

    const results = [];
    for (const group of chunk(sample, 10)) {
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
    console.error("top-news:", e.message);
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
app.post("/api/community-posts", authenticate, async (req,res)=>{
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
|  17) Automated-investor & daily job      |
└──────────────────────────────────────────*/
// 18) AUTOMATED INVESTOR SECTION
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
  //  – implement your auto-sell logic here –
}

// Example scheduler (disabled by default):
// setInterval(async () => {
//   try {
//     await autoBuyStocks();
//     await autoSellStocks();
//   } catch (err) {
//     console.error("Automated-investor task error:", err.message);
//   }
// }, 60_000);

// ────────────────────────────────────────────────────────────
// 18-B) Daily Job: Refresh All Historical Data
// ────────────────────────────────────────────────────────────
const ONE_DAY = 24 * 60 * 60 * 1000;

async function refreshAllHistoricalData() {
  try {
    if (!fs.existsSync(SYMBOLS_JSON_PATH)) {
      console.log("No symbols.json found, skipping daily historical fetch.");
      return;
    }

    const symbols = JSON.parse(fs.readFileSync(SYMBOLS_JSON_PATH, "utf-8"));
    await fetchAllSymbolsHistoricalData(symbols, 1);   // 1-day look-back
  } catch (err) {
    console.error("Error in refreshAllHistoricalData:", err.message);
  }
}

 if (!DISABLE_BG) {
  setInterval(() => {
    console.log("⏰ Running daily refreshAllHistoricalData…");
    refreshAllHistoricalData();
  }, ONE_DAY);
}


// GET /api/sci/score/:symbol  -> rule decision, confidence, and optional regression
app.get('/api/sci/score/:symbol', async (req, res) => {
  try {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!isValidSymbol(sym)) return res.status(400).json({ message: 'unknown symbol' });

    // use same daily fetch you already have
    const rows = await stGetDaily(sym, 300); // ~300 bars
    const rule = sciV1.scoreWithRows(rows);

    // optional regression prediction if a model is loaded
    let rhat = null, regClass = null;
    if (rule.in_universe) {
      const f = sciV1.computeIndicators(rows);
      rhat = sciV1.predictReturnFromIndicators(f); // next-day log return
      if (typeof rhat === 'number') {
        const band = 0.003; // ±0.30% neutral band
        regClass = rhat > +band ? 'Up' : rhat < -band ? 'Down' : 'Neutral';
      }
    }

    // fused call (conservative): prefer rules unless regression strongly disagrees
    let fused = rule.decision.final;
    let explanation = null;
    if (regClass) {
      if (fused === 'Neutral') fused = regClass;
      else if ((fused === 'Up' && regClass === 'Down') || (fused === 'Down' && regClass === 'Up')) {
        if (Math.abs(rhat) > 0.006) fused = 'Neutral';
      }
    }

    if (req.query.explain === '1') {
      const system = 'Explain succinctly the rule decision using the provided indicators and gaps. ≤100 words.';
      const payload = {
        symbol: sym,
        final: fused,
        rule: rule.decision,
        regression: { rhat, regClass },
        indicators: {
          zS: rule.indicators.zS,
          z_dS: rule.indicators.z_dS,
          z_dHist: rule.indicators.z_dHist,
          K: rule.indicators.K,
          pctB: rule.indicators.pctB,
          CLV: rule.indicators.CLV,
          logRV: rule.indicators.logRV,
          z_dLogRV: rule.indicators.z_dLogRV,
          obvSlope10: rule.indicators.obvSlope10,
          z_obvSl: rule.indicators.z_obvSl,
          atrPct: rule.indicators.atrPct,
          z_ATRPct: rule.indicators.z_ATRPct,
          BBW: rule.indicators.BBW,
          z_dBBW: rule.indicators.z_dBBW,
          g: rule.indicators.g,
          gapNorm: rule.indicators.gapNorm,
          fill: rule.indicators.fill
        }
      };
      const text = await callChatServiceAdaptive({
        system,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      });
      explanation = text;
    }

    res.json({
      symbol: sym,
      in_universe: rule.in_universe,
      rule: rule.decision,
      indicators: rule.indicators,
      regression: { rhat, regClass },
      final: fused,
      explanation
    });
  } catch (e) {
    console.error('sci/score:', e.message);
    res.status(500).json({ message: 'sci/score failed' });
  }
});

// POST /api/sci/train  { symbols?:[...], days?:600, lambda?:0.01 }
app.post('/api/sci/train', authenticate, async (req, res) => {
  try {
    const { symbols, days = 600, lambda = 1e-2 } = req.body || {};
    const pool = (Array.isArray(symbols) && symbols.length ? symbols
                  : symbolsList.slice(0, 80).map(s => (typeof s === 'string' ? s : s.symbol)));

    // gather samples across symbols
    const samples = [];
    for (const s of pool) {
      try {
        const rows = await stGetDaily(s, Math.max(130, days));
        const local = sciV1.buildDatasetFromRows(rows);
        samples.push(...local);
      } catch {}
    }
    if (samples.length < 1000) return res.status(400).json({ message: 'not enough samples' });

    // standardize + fit ridge
    const { X, y, means, stds } = sciV1.standardizeXY(samples);
    const w = await sciV1.ridgeFit(X, y, lambda);

    // store in the module and persist to disk
    const modelPath = path.join(__dirname, 'model', 'sci_v1_regression.json');
    sciV1.loadModelFromDisk(); // ensure structure exists
    const REG = { loaded: true, w, means, stds, lambda };
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, JSON.stringify(REG, null, 2));

    res.json({ ok: true, symbols: pool.length, samples: samples.length, d: w.length, lambda, modelPath });
  } catch (e) {
    console.error('sci/train:', e.message);
    res.status(500).json({ message: 'sci/train failed' });
  }
});

// 18-C) Daily fundamentals refresh at 2:00 AM ET, weekdays
const watchlist = Array.from(new Set(
  (portfolio || []).map(p => p.symbol).filter(Boolean).concat(['AAPL','MSFT','NVDA'])
));

async function pullCompanyFundamentals(symbol) {
  try {
    await getFundamentals(symbol);
    console.log(`✅ Refreshed fundamentals for ${symbol}`);
  } catch (err) {
    console.error(`❌ pullCompanyFundamentals(${symbol}):`, err.message);
  }
}

 if (!DISABLE_BG) {
   cron.schedule('0 2 * * 1-5', () => {
     console.log('⏰ Running daily pullCompanyFundamentals…');
     watchlist.forEach(sym => pullCompanyFundamentals(sym));
   }, { timezone: 'America/New_York' });
 }

/*──────────────────────────────────────────
|  Start server                            |
└──────────────────────────────────────────*/
const PORT = process.env.PORT || 5000;

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

app.listen(PORT, () => console.log(`✅ Combined server running on port ${PORT}`));

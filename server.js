// ============================================================
//  GRID BOT BACKEND  —  server.js
//  Multi-exchange: Binance (Spot/USDM/CoinM) + Deribit (Perp)
//  - One bot per exchange, can run simultaneously
//  - Telegram alerts per exchange (with exchange tag)
//  - Deribit: real PnL with maker rebates
// ============================================================

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const http      = require("http");
const WebSocket = require("ws");
const ccxt      = require("ccxt");
const https     = require("https");
const crypto    = require("crypto");
const fs        = require("fs");
const path      = require("path");
// Native Hyperliquid SDK — used as fallback because CCXT's Hyperliquid
// integration has known bugs with fetchOpenOrders and cancelOrder.
const hl        = require("@nktkas/hyperliquid");
const { privateKeyToAccount } = require("viem/accounts");
const db        = require("./db");

// Fields stripped before saving a bot session to MySQL. These are
// re-injected from .env on resume via injectKeysIntoCfg.
const SESSION_SECRET_FIELDS = ["apiKey", "secretKey", "telegramToken"];
function stripSecrets(cfg) {
  const out = {};
  for (const k of Object.keys(cfg || {})) {
    if (!SESSION_SECRET_FIELDS.includes(k)) out[k] = cfg[k];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Per-bot log files. Each bot writes to logs/<botId>.log so you
// can `tail -f` any single bot in its own terminal. The single
// server process still runs all bots; only the log STREAM is split.
// ─────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, "logs");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch(e) {}
const logStreams = {};   // { botId: WriteStream }
function getLogStream(botId) {
  if (!logStreams[botId]) {
    const fp = path.join(LOG_DIR, `${botId}.log`);
    logStreams[botId] = fs.createWriteStream(fp, { flags: "a" });
    // Header for new sessions
    logStreams[botId].write(`\n${"=".repeat(60)}\n=== Session start: ${new Date().toISOString()}\n${"=".repeat(60)}\n`);
  }
  return logStreams[botId];
}
function closeLogStream(botId) {
  if (logStreams[botId]) {
    try { logStreams[botId].end(); } catch(e) {}
    delete logStreams[botId];
  }
}

const app    = express();
const server = http.createServer(app);

// ────────────────────────────────────────────────────────────
// SESSION-BASED AUTH (cookie). Configured via DASHBOARD_USER +
// DASHBOARD_PASSWORD in .env. If either is unset, auth is disabled.
// Localhost requests bypass auth so resumeSessions's internal POST to
// /api/start works without credentials.
//   - POST /api/login        — issues a session cookie
//   - POST /api/logout       — clears it
//   - GET  /api/auth/status  — reports auth state (public)
//   - /login.html            — public, serves the login page
//   - everything else        — requires a valid session cookie
// ────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const sessions = new Map(); // sid -> expiresAt (ms epoch)

function genSessionId() { return crypto.randomBytes(32).toString("hex"); }

function isSessionValid(sid) {
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(sid); return false; }
  return true;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    let v = part.slice(idx + 1).trim();
    try { v = decodeURIComponent(v); } catch (e) {}
    out[k] = v;
  }
  return out;
}

function isAuthDisabled() {
  return !process.env.DASHBOARD_USER || !process.env.DASHBOARD_PASSWORD;
}
function isLocalhostReq(req) {
  const ip = req.ip || req.connection?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// Paths that never require auth (login flow + the login page itself).
const PUBLIC_PATHS = new Set([
  "/login.html",
  "/api/login",
  "/api/logout",
  "/api/auth/status",
]);

function sessionAuthMiddleware(req, res, next) {
  if (isAuthDisabled()) return next();
  if (isLocalhostReq(req)) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie);
  if (isSessionValid(cookies.session)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.redirect("/login.html");
}

const wss = new WebSocket.Server({
  server,
  verifyClient: (info, cb) => {
    if (isAuthDisabled()) return cb(true);
    const ip = info.req.socket?.remoteAddress || "";
    const localhost = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (localhost) return cb(true);
    const cookies = parseCookies(info.req.headers.cookie);
    if (isSessionValid(cookies.session)) return cb(true);
    cb(false, 401, "Unauthorized");
  },
});

app.use(cors());
app.use(express.json());
app.use(sessionAuthMiddleware);
app.use(express.static(__dirname));

// ── Login / Logout / Status ──
app.post("/api/login", (req, res) => {
  if (isAuthDisabled()) return res.json({ ok: true, authDisabled: true });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });
  if (username !== process.env.DASHBOARD_USER || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const sid = genSessionId();
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  res.setHeader(
    "Set-Cookie",
    `session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) sessions.delete(cookies.session);
  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/auth/status", (req, res) => {
  if (isAuthDisabled()) return res.json({ authenticated: true, authDisabled: true });
  const cookies = parseCookies(req.headers.cookie);
  res.json({ authenticated: isSessionValid(cookies.session) });
});

// ============================================================
//  MULTI-BOT STATE
//  Each exchange has its own isolated bot instance.
//  bots.binance and bots.deribit can run independently.
// ============================================================
function makeFreshBot(exchangeKey, botId) {
  return {
    botId,
    exchangeKey,
    label               : null,
    running             : false,
    config              : null,
    exchange            : null,
    openOrders          : [],
    entryPrice          : null,
    lastPrice           : null,
    bestBid             : null,
    bestAsk             : null,
    upperLimit          : null,
    lowerLimit          : null,
    fillHistory         : [],
    pendingRoundTrips   : [],
    completedRoundTrips : [],
    recentlyCancelled   : {},
    logs                : [],
    loopTimer           : null,
    loopCount           : 0,
    lastNotifiedRt      : 0,
    gridAnchor          : null,
    startedAt           : null,   // ms timestamp when bot was started (for runtime display)
    stats               : null,
    hlCache             : null,
    hedge : {
      enabled          : false,
      futuresExchange  : null,
      currentShortQty  : 0,
      targetShortQty   : 0,
      spotInventory    : 0,
      lastCheckTs      : 0,
      lastRebalanceTs  : 0,
      symbol           : "SOL/USD:SOL",
      log              : [],
    },
  };
}

// ── DYNAMIC BOT REGISTRY ──────────────────────────────────────────────
// Keyed by unique botId. Run many bots at once (HYPE perp + BTC perp +
// ETH spot, etc). The 3 legacy keys remain as default first-bot slots
// for backward compatibility (Binance hedge code, Telegram menus).
const bots = {
  binance     : makeFreshBot("binance",     "binance"),
  deribit     : makeFreshBot("deribit",     "deribit"),
  hyperliquid : makeFreshBot("hyperliquid", "hyperliquid"),
};

let botIdCounter = 1;
function createBotInstance(exchangeKey, label) {
  const botId = `${exchangeKey}_${++botIdCounter}`;
  const bot = makeFreshBot(exchangeKey, botId);
  bot.label = label || botId;
  bots[botId] = bot;
  return bot;
}
function removeBotInstance(botId) {
  if (botId === "binance" || botId === "deribit" || botId === "hyperliquid") {
    bots[botId] = makeFreshBot(botId, botId);
    // Keep the legacy slot's log stream open — it's reusable
  } else {
    delete bots[botId];
    closeLogStream(botId);  // dynamic bot gone; release file handle
  }
}
function listBots() { return Object.values(bots); }


const EXCHANGE_TAG = {
  binance     : "🟦 Binance",
  deribit     : "🟧 Deribit",
  hyperliquid : "🟣 Hyperliquid",
};

// ============================================================
//  MAKER FEE RATES (post-only guarantees maker, so we use these)
//  Keyed by priceSource (perp vs spot fee schedules differ).
//  Values are decimal rates (0.00015 = 0.015% = 1.5 bps).
//  Update these if the user gets a discount tier / stakes HYPE / etc.
// ============================================================
const MAKER_FEE_RATE = {
  // Hyperliquid
  hyperliquid       : 0.000144,  // perps maker (your tier shows 0.0144%)
  hyperliquid_spot  : 0.000384,  // spot maker (your tier shows 0.0384%)
  // Binance
  binance_spot      : 0.001000,  // 0.10% standard spot maker (BNB pays 0.075%)
  binance_usdm      : 0.000200,  // 0.02% USDM futures maker
  binance_coinm     : 0.000100,  // 0.01% COIN-M futures maker
  // Deribit
  deribit           : -0.000010, // -0.01% maker REBATE on options (yes, you get paid)
  deribit_spot      :  0.000000, // spot maker = 0
};
function feeRateFor(priceSource) {
  return MAKER_FEE_RATE[priceSource] ?? 0.0005;   // 0.05% conservative default
}
function estimateFee(priceSource, price, qty) {
  return Math.abs(feeRateFor(priceSource) * price * qty);
}

// ============================================================
//  TELEGRAM ENGINE
// ============================================================
const tgConv   = {};
let   tgOffset = 0;

function tgPost(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host:"api.telegram.org", path:`/bot${token}/${method}`, method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload),"User-Agent":"node"},
    }, (res) => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){resolve(null)}});
    });
    req.on("error",()=>resolve(null));
    req.write(payload); req.end();
  });
}

async function sendTelegram(token, chatId, message) {
  if (!token)  { console.log("[TELEGRAM] SKIPPED — TELEGRAM_BOT_TOKEN not set"); return; }
  if (!chatId) { console.log("[TELEGRAM] SKIPPED — TELEGRAM_CHAT_ID not set"); return; }
  console.log(`[TELEGRAM] ${String(message).substring(0,80)}`);
  const r = await tgPost("sendMessage", {chat_id:chatId, text:message, parse_mode:"HTML"});
  if (!r?.ok) console.error("[TELEGRAM] error:", r?.description||"unknown");
}

function tgSend(chatId, text, keyboard) {
  const body = {chat_id:chatId, text, parse_mode:"HTML", disable_web_page_preview:true};
  if (keyboard) body.reply_markup = {inline_keyboard:keyboard};
  return tgPost("sendMessage", body);
}

function tgEdit(chatId, msgId, text, keyboard) {
  const body = {chat_id:chatId, message_id:msgId, text, parse_mode:"HTML", disable_web_page_preview:true};
  body.reply_markup = {inline_keyboard: keyboard||[]};
  return tgPost("editMessageText", body);
}

function tgAck(queryId, toast) {
  return tgPost("answerCallbackQuery", {callback_query_id:queryId, text:toast||""});
}

// ── Telegram sendDocument (multipart/form-data, no external deps) ──
// Telegram's sendDocument requires multipart/form-data when uploading a
// file from memory. We build the multipart body manually with a unique
// boundary, then POST it with Node's https module.
function tgSendDocument(chatId, filename, contentBuffer, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const boundary = "----GridBot" + crypto.randomBytes(16).toString("hex");
    const CRLF = "\r\n";

    // Build multipart body as Buffer (because file content is binary)
    const parts = [];
    const pushField = (name, value) => {
      parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
    };
    pushField("chat_id", String(chatId));
    if (caption) pushField("caption", caption);
    if (caption) pushField("parse_mode", "HTML");

    // File part
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}` +
      `Content-Type: text/csv${CRLF}${CRLF}`
    ));
    parts.push(Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer));
    parts.push(Buffer.from(CRLF));

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));

    const body = Buffer.concat(parts);

    const req = https.request({
      host: "api.telegram.org",
      path: `/bot${token}/sendDocument`,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        "User-Agent": "node",
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

// ── Telegram menus ──────────────────────────────────────────
function exchangeSelectorMenu(action) {
  return [
    [
      {text:`🟦 Binance ${bots.binance.running?"🟢":"🔴"}`, callback_data:`pick_binance_${action}`},
      {text:`🟧 Deribit ${bots.deribit.running?"🟢":"🔴"}`, callback_data:`pick_deribit_${action}`},
    ],
    [
      {text:`🟣 Hyperliquid ${bots.hyperliquid.running?"🟢":"🔴"}`, callback_data:`pick_hyperliquid_${action}`},
    ],
    [{text:"⬅ Back to Menu", callback_data:"main_menu"}],
  ];
}

function mainMenu() {
  return [
    [{text:"📊 Status",      callback_data:"act_status"   },{text:"💼 Portfolio",  callback_data:"act_portfolio"}],
    [{text:"🔄 Restart Bot", callback_data:"act_restart"  },{text:"⏹ Stop Bot",   callback_data:"act_stop"     }],
    [{text:"📈 PnL Report",  callback_data:"act_report"   },{text:"📥 Download CSV", callback_data:"act_csv"  }],
    [{text:"❓ Help",         callback_data:"act_help"     }],
  ];
}

function exchangeMenu(exchangeKey) {
  const e = exchangeKey;
  const tag = EXCHANGE_TAG[e];
  return [
    [{text:`📊 ${tag} Status`, callback_data:`do_status_${e}`}, {text:`💼 Portfolio`, callback_data:`do_portfolio_${e}`}],
    [{text:`🔄 Restart`, callback_data:`do_restart_${e}`}, {text:`⏹ Stop`, callback_data:`do_stop_${e}`}],
    [{text:`📈 PnL Report`, callback_data:`do_report_${e}`}, {text:`📥 CSV`, callback_data:`do_csv_${e}`}],
    [{text:"⬅ Back", callback_data:"main_menu"}],
  ];
}

function tgStatusText(exchangeKey) {
  const s   = bots[exchangeKey];
  const tag = EXCHANGE_TAG[exchangeKey];
  const cfg = s.config;
  if (!s.running) return `<b>${tag} — 🔴 STOPPED</b>\n\nBot is not running.\nTap 🔄 Restart to bring it back.`;
  const st = s.stats || {};
  const runtime = s.startedAt ? formatDuration(Date.now() - s.startedAt) : "—";
  const netPnl  = st.netPnl ?? st.totalPnl ?? 0;
  const netSign = netPnl >= 0 ? "+" : "";
  return `<b>${tag} — 🟢 RUNNING</b>

📌 <b>Symbol :</b> <code>${cfg?.symbol||"—"}</code>
⏱ <b>Runtime:</b> <code>${runtime}</code>
💵 <b>Price  :</b> <code>$${(s.lastPrice||0).toFixed(4)}</code>
🎯 <b>Entry  :</b> <code>$${(s.entryPrice||0).toFixed(4)}</code>
🔼 <b>Upper  :</b> <code>$${(s.upperLimit||0).toFixed(4)}</code>
🔽 <b>Lower  :</b> <code>$${(s.lowerLimit||0).toFixed(4)}</code>

📦 <b>Open Orders :</b> <code>${s.openOrders.length}</code>
✅ <b>Round Trips :</b> <code>${st.totalRoundTrips||0}</code>
💰 <b>Gross PnL   :</b> <code>+$${(st.grossPnl||0).toFixed(4)}</code>
💸 <b>Fees        :</b> <code>-$${(st.rtFees||0).toFixed(4)}</code>
💵 <b>Net PnL     :</b> <code>${netSign}$${netPnl.toFixed(4)}</code>
📊 <b>Buys / Sells:</b> <code>${st.totalBuys||0} / ${st.totalSells||0}</code>

⚙️ <b>Sell spacing :</b> <code>$${cfg?.avgSellSpacing||"—"}</code>
⚙️ <b>Buy  spacing :</b> <code>$${cfg?.avgBuySpacing||"—"}</code>
⚙️ <b>Target spread:</b> <code>$${cfg?.targetSpread||"—"}</code>
⚙️ <b>Qty / step   :</b> <code>${cfg?.qtyPerStep||"—"}</code>
📏 <b>Distance     :</b> <code>$${cfg?.distance||"—"}</code>`;
}

function tgHelpText() {
  return `<b>🤖 Grid Bot — Commands</b>

/menu       Show control panel
/status     Live bot status (pick exchange)
/portfolio  Portfolio (pick exchange)
/report     PnL report (pick exchange)
/csv        Download 24h CSV (pick exchange)
/restart    Restart / Launch a bot
/stop       Stop a bot

<b>/restart — no UI needed:</b>
After picking an exchange, send either:
• <b>5 numbers</b> (reuses last symbol):
  <code>sell buy target qty distance</code>
• <b>7 values</b> (fresh start, any symbol):
  <code>sell buy target qty distance priceSource symbol</code>

<b>Example (cold start, no UI):</b>
<code>0.05 0.05 0.05 1 2 hyperliquid HYPE/USDC:USDC</code>`;
}

function restartPromptText(exchangeKey, lastCfg) {
  const tag = EXCHANGE_TAG[exchangeKey];
  if (lastCfg) {
    return `🔄 <b>Restart ${tag}</b>\n\n` +
      `📌 <b>Last used:</b>\n<code>${lastCfg.avgSellSpacing} ${lastCfg.avgBuySpacing} ${lastCfg.targetSpread} ${lastCfg.qtyPerStep} ${lastCfg.distance}</code>\n` +
      `Symbol: <code>${lastCfg.symbol}</code> via <code>${lastCfg.priceSource}</code>\n\n` +
      `<b>Quick restart — send 5 numbers</b> (reuses symbol):\n` +
      `<code>sell buy target qty distance</code>\n\n` +
      `<b>Or change symbol — send 7 values:</b>\n` +
      `<code>sell buy target qty distance priceSource symbol</code>`;
  }
  // No previous config → MUST send full 7
  return `🆕 <b>Launch ${tag} (no previous config)</b>\n\n` +
    `Send <b>7 values</b>:\n` +
    `<code>sell buy target qty distance priceSource symbol</code>\n\n` +
    `<b>Examples (copy & paste):</b>\n` +
    `HL perp HYPE:\n<code>0.05 0.05 0.05 1 2 hyperliquid HYPE/USDC:USDC</code>\n\n` +
    `HL spot HYPE:\n<code>0.05 0.05 0.05 0.3 1 hyperliquid_spot HYPE/USDC</code>\n\n` +
    `Binance SOL/FDUSD:\n<code>0.25 0.25 0.5 1.166 5 binance_spot SOL/FDUSD</code>`;
}

function tgReportText(exchangeKey) {
  const now=Date.now(), fromTs=now-24*60*60*1000;
  const r = getRoundTripReport(exchangeKey, fromTs, now);
  const cfg = bots[exchangeKey].config;
  const tag = EXCHANGE_TAG[exchangeKey];
  const isDeribit = exchangeKey === "deribit";
  const feesSection = isDeribit
    ? `Fees    : <code>$${(r.totalFees||0).toFixed(4)}</code>
Rebates : <code>$${(r.totalRebates||0).toFixed(4)}</code>
Net PnL : <b>$${(r.netPnl||r.pnl||0).toFixed(4)}</b>
`
    : "";

  return `<b>📈 ${tag} 24 h PnL Report</b>

Symbol  : <code>${cfg?.symbol||"—"}</code>
RTs     : <code>${r.count}</code>
PnL/RT  : <code>+$${(r.perRtPnl||0).toFixed(4)}</code>
Gross   : <code>$${(r.pnl||0).toFixed(4)}</code>
Avg spread : <code>$${(r.avgSpread||0).toFixed(4)}</code>  (target: <code>$${cfg?.targetSpread||0}</code>)
${feesSection}Buys    : <code>${r.periodBuys}</code>   Sells: <code>${r.periodSells}</code>

Tap 📥 CSV for full 24h export.`;
}

// ============================================================
//  BINANCE PORTFOLIO HELPERS (preserved from original)
// ============================================================
let _portfolioTsOffset = 0;
let _portfolioTsLastFetch = 0;
async function getPortfolioTsOffset() {
  const now = Date.now();
  if (now - _portfolioTsLastFetch < 60_000) return _portfolioTsOffset;
  const binanceTestnet = String(process.env.BINANCE_TESTNET || "").toLowerCase() === "true";
  const host = binanceTestnet ? "testnet.binance.vision" : "api.binance.com";
  try {
    const serverTime = await new Promise((resolve, reject) => {
      https.get({ host, path:"/api/v3/time", headers:{"User-Agent":"node"} }, (res) => {
        let raw=""; res.on("data",c=>raw+=c);
        res.on("end",()=>{ try{resolve(JSON.parse(raw).serverTime)}catch(e){reject(e)} });
      }).on("error", reject);
    });
    _portfolioTsOffset    = serverTime - Date.now();
    _portfolioTsLastFetch = Date.now();
  } catch(e) {}
  return _portfolioTsOffset;
}
async function binanceTs() { return Date.now() + await getPortfolioTsOffset(); }

function fapiSignedGet(path, apiKey, secretKey, ts) {
  const binanceTestnet = String(process.env.BINANCE_TESTNET || "").toLowerCase() === "true";
  const host = binanceTestnet ? "testnet.binancefuture.com" : "fapi.binance.com";
  return new Promise((resolve, reject) => {
    const q=`timestamp=${ts}&recvWindow=60000`;
    const sig=crypto.createHmac("sha256",secretKey).update(q).digest("hex");
    https.get({host, path:`${path}?${q}&signature=${sig}`,headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"}},
      (res)=>{let raw="";res.on("data",c=>raw+=c);res.on("end",()=>{try{resolve(JSON.parse(raw))}catch(e){reject(new Error(raw.slice(0,200)))}});
    }).on("error",reject);
  });
}

function dapiSignedRequest(path, apiKey, secretKey, tsOverride) {
  // NOTE: Coin-M (dapi) has NO Binance testnet, so we always go to production
  // here even when BINANCE_TESTNET=true. The fapiSignedGet path uses testnet
  // when applicable; this one cannot.
  return new Promise((resolve, reject) => {
    const timestamp = tsOverride || Date.now();
    const queryStr  = `timestamp=${timestamp}&recvWindow=60000`;
    const signature = crypto.createHmac("sha256", secretKey).update(queryStr).digest("hex");
    const fullPath  = `${path}?${queryStr}&signature=${signature}`;
    https.get({ host:"dapi.binance.com", path:fullPath, headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"} }, (res) => {
      let raw=""; res.on("data",c=>raw+=c);
      res.on("end",()=>{ try{resolve(JSON.parse(raw))}catch(e){reject(new Error("Bad JSON: "+raw.slice(0,200)))} });
    }).on("error", reject);
  });
}

async function fetchAllSpotPrices() {
  const base      = (bots.binance.config?.symbol||"SOL/FDUSD").split("/")[0];
  const livePrice = bots.binance.lastPrice || 0;
  const map = {};
  if (base && livePrice) map[`${base}USDT`] = livePrice;
  try {
    const raw = await new Promise((resolve, reject) => {
      https.get({host:"api.binance.com",path:"/api/v3/ticker/price",headers:{"User-Agent":"node"}},
        (res)=>{let d="";res.on("data",c=>d+=c);res.on("end",()=>{try{resolve(JSON.parse(d))}catch(e){reject(e)}});
      }).on("error",reject);
    });
    if (Array.isArray(raw)) raw.forEach(t=>{ map[t.symbol]=parseFloat(t.price); });
  } catch(e) {}
  return map;
}

function coinToUsdt(asset, qty, px) {
  if (!qty||qty===0) return 0;
  if (asset==="USDT") return qty;
  const stables=["FDUSD","BUSD","TUSD","USDC","DAI","USDP"];
  if (stables.includes(asset)) return qty*(px[`${asset}USDT`]||1);
  if (px[`${asset}USDT`])      return qty*px[`${asset}USDT`];
  if (px[`${asset}BTC`]&&px["BTCUSDT"]) return qty*px[`${asset}BTC`]*px["BTCUSDT"];
  if (px[`${asset}ETH`]&&px["ETHUSDT"]) return qty*px[`${asset}ETH`]*px["ETHUSDT"];
  const base=(bots.binance.config?.symbol||"SOL/FDUSD").split("/")[0];
  if (asset===base && bots.binance.lastPrice) return qty*bots.binance.lastPrice;
  return 0;
}

async function tgBinancePortfolioText() {
  const apiKey    = process.env.BINANCE_API_KEY;
  const secretKey = process.env.BINANCE_SECRET_KEY;
  const futKey    = process.env.FUTURES_API_KEY    || apiKey;
  const futSecret = process.env.FUTURES_SECRET_KEY || secretKey;
  if (!apiKey||!secretKey) return "❌ Binance API keys not configured in .env";

  const ts        = await binanceTs();
  const px        = await fetchAllSpotPrices();
  const botSymbol = bots.binance.config?.symbol||"SOL/FDUSD";
  const base      = botSymbol.split("/")[0];

  const spotGet = (path) => new Promise((res,rej)=>{
    const q=`timestamp=${ts}&recvWindow=60000`;
    const sig=crypto.createHmac("sha256",secretKey).update(q).digest("hex");
    https.get({host:"api.binance.com",path:`${path}?${q}&signature=${sig}`,
      headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"}},
      (r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});
    }).on("error",rej);
  });

  let spotLines="", spotTotal=0;
  try {
    const spotData = await spotGet("/api/v3/account");
    if (spotData.code && spotData.msg) {
      spotLines = `  ❌ Binance error ${spotData.code}: ${spotData.msg}\n`;
    } else {
      const nonZero=(spotData.balances||[]).filter(b=>parseFloat(b.free||0)+parseFloat(b.locked||0)>0.00001);
      for (const b of nonZero) {
        const qty   =parseFloat(b.free||0)+parseFloat(b.locked||0);
        const usdVal=coinToUsdt(b.asset,qty,px);
        if (usdVal<0.01) continue;
        spotTotal+=usdVal;
        const lk=parseFloat(b.locked||0)>0?` <i>(${parseFloat(b.locked).toFixed(4)} locked)</i>`:"";
        spotLines+=`  <code>${b.asset.padEnd(8)}</code>${qty.toFixed(4)}${lk} ≈ <b>$${usdVal.toFixed(2)}</b>\n`;
      }
      if (!spotLines) spotLines="  (no non-zero balances)\n";
    }
  } catch(e) { spotLines=`  ❌ ${e.message}\n`; }

  let coinmLines="", coinmTotal=0;
  try {
    const coinmData = await dapiSignedRequest("/dapi/v1/account", futKey, futSecret, ts);
    if (coinmData.code && coinmData.msg) {
      coinmLines = `  ❌ Binance error ${coinmData.code}: ${coinmData.msg}\n`;
    } else if (Array.isArray(coinmData.assets)) {
      for (const a of coinmData.assets) {
        const wallet =parseFloat(a.walletBalance   ||0);
        const unrealP=parseFloat(a.unrealizedProfit||0);
        const equity =wallet+unrealP;
        if (Math.abs(equity)<0.000001) continue;
        const coinPrice=px[`${a.asset}USDT`]||bots.binance.lastPrice||0;
        const usdVal   =coinToUsdt(a.asset,equity,px);
        coinmTotal    +=usdVal;
        const pnlNote =unrealP!==0?` (uPnL ${unrealP>=0?"+":""}${unrealP.toFixed(4)} ${a.asset})`:"";
        const calcNote=coinPrice>0?` × $${coinPrice.toFixed(2)}`:"";
        coinmLines+=`  <code>${a.asset.padEnd(6)}</code>${equity.toFixed(4)}${calcNote}${pnlNote} = <b>$${usdVal.toFixed(2)}</b>\n`;
      }
      try {
        const pos=await dapiSignedRequest("/dapi/v1/positionRisk",futKey,futSecret,ts);
        if (Array.isArray(pos)) {
          pos.filter(p=>parseFloat(p.positionAmt)!==0).forEach(p=>{
            const side=parseFloat(p.positionAmt)<0?"SHORT":"LONG";
            const uPnl=parseFloat(p.unRealizedProfit||0);
            coinmLines+=`  📍 ${p.symbol} ${side}  uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(2)}\n`;
          });
        }
      } catch(_){}
      if (!coinmLines) coinmLines="  (no balances)\n";
    } else {
      coinmLines=`  ⚠️ Unexpected: ${JSON.stringify(coinmData).slice(0,120)}\n`;
    }
  } catch(e) { coinmLines=`  ❌ ${e.message}\n`; }

  let usdmLines="", usdmTotal=0;
  try {
    const usdmData = await fapiSignedGet("/fapi/v2/account", futKey, futSecret, ts);
    if (usdmData.code && usdmData.msg) {
      usdmLines=`  ❌ Binance error ${usdmData.code}: ${usdmData.msg}\n`;
    } else if (Array.isArray(usdmData.assets)) {
      for (const a of usdmData.assets) {
        const w=parseFloat(a.walletBalance||0),u=parseFloat(a.unrealizedProfit||0);
        const equity=w+u;
        if (Math.abs(equity)<0.01) continue;
        usdmTotal+=equity;
        const pnlNote=u!==0?` (PnL ${u>=0?"+":""}$${u.toFixed(2)})`:"";
        usdmLines+=`  <code>${a.asset.padEnd(8)}</code>$${equity.toFixed(2)}${pnlNote}\n`;
      }
      if (!usdmLines) usdmLines="  (no balances)\n";
    } else if (usdmData.totalWalletBalance!==undefined) {
      const w=parseFloat(usdmData.totalWalletBalance||0),u=parseFloat(usdmData.totalUnrealizedProfit||0);
      usdmTotal=w+u;
      usdmLines=`  <code>USDT    </code>$${usdmTotal.toFixed(2)} (PnL ${u>=0?"+":""}$${u.toFixed(2)})\n`;
    }
  } catch(e) { usdmLines=`  ❌ ${e.message}\n`; }

  const grandTotal=spotTotal+coinmTotal+usdmTotal;
  const livePrice =bots.binance.lastPrice||px[`${base}USDT`]||0;

  return `<b>💼 🟦 Binance Portfolio</b>
<i>${new Date().toLocaleString()}</i>

━━━━━━━━━━━━━━━━━━━━━━━━━
🏦 <b>SPOT Wallet</b>
${spotLines}  Subtotal: <b>$${spotTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
📉 <b>COIN-M Futures</b>
${coinmLines}  Subtotal: <b>$${coinmTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
📈 <b>USDM Futures</b>
${usdmLines}  Subtotal: <b>$${usdmTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>TOTAL: $${grandTotal.toFixed(2)} USDT</b>
<i>${base} price: $${livePrice.toFixed(4)}</i>`;
}

// ============================================================
//  DERIBIT PORTFOLIO + PnL (with rebates)
// ============================================================
async function tgDeribitPortfolioText() {
  const cid    = process.env.DERIBIT_CLIENT_ID;
  const secret = process.env.DERIBIT_CLIENT_SECRET;
  if (!cid || !secret) return "❌ Deribit API keys not configured (need DERIBIT_CLIENT_ID and DERIBIT_CLIENT_SECRET in .env)";

  try {
    let ex = bots.deribit.exchange;
    if (!ex) {
      ex = buildExchange("deribit", cid, secret);
      await ex.loadMarkets();
    }

    const balance   = await ex.fetchBalance();
    const positions = await ex.fetchPositions().catch(()=>[]);

    let lines = "";
    let total = 0;
    const totals = balance.total || {};
    const currencies = Object.keys(totals).filter(c => Math.abs(totals[c]||0) > 0.00001);

    if (currencies.length === 0) {
      lines = "  (no balances)\n";
    } else {
      const prices = {};
      for (const c of currencies) {
        if (c === "USDC" || c === "USDT" || c === "USD") { prices[c] = 1; continue; }
        try {
          const ticker = await ex.fetchTicker(`${c}/USD:${c}`).catch(()=>null);
          prices[c] = ticker?.last || 0;
        } catch(_) { prices[c] = 0; }
      }
      for (const c of currencies) {
        const qty  = totals[c] || 0;
        const used = balance.used?.[c] || 0;
        const px   = prices[c] || 0;
        const usd  = qty * px;
        if (Math.abs(usd) < 0.01 && c !== "USDC" && c !== "USDT") continue;
        total += usd;
        const usedNote = used > 0 ? ` <i>(${used.toFixed(6)} margin)</i>` : "";
        lines += `  <code>${c.padEnd(6)}</code>${qty.toFixed(6)}${usedNote} ≈ <b>$${usd.toFixed(2)}</b>\n`;
      }
    }

    let posLines = "";
    const openPositions = positions.filter(p => parseFloat(p.contracts || p.info?.size || 0) !== 0);
    if (openPositions.length > 0) {
      for (const p of openPositions) {
        const sz   = parseFloat(p.contracts || p.info?.size || 0);
        const side = sz > 0 ? "LONG" : "SHORT";
        const uPnl = parseFloat(p.unrealizedPnl ?? p.info?.total_profit_loss ?? 0);
        const mark = parseFloat(p.markPrice ?? p.info?.mark_price ?? 0);
        posLines += `  📍 <code>${p.symbol}</code> ${side} ${Math.abs(sz)} @ $${mark.toFixed(2)} | uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(4)}\n`;
      }
    } else {
      posLines = "  (no open positions)\n";
    }

    return `<b>💼 🟧 Deribit Portfolio</b>
<i>${new Date().toLocaleString()}</i>

━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>Balances</b>
${lines}  Subtotal: <b>$${total.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Open Positions</b>
${posLines}
━━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>TOTAL: $${total.toFixed(2)} USD</b>`;

  } catch(err) {
    return `❌ Deribit portfolio fetch failed:\n<code>${err.message}</code>`;
  }
}

// ── Hyperliquid portfolio (uses CCXT fetchBalance + fetchPositions) ──
async function tgHyperliquidPortfolioText() {
  const walletAddr = process.env.HYPERLIQUID_WALLET_ADDRESS;
  const privateKey = process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!walletAddr || !privateKey) return "❌ HYPERLIQUID_WALLET_ADDRESS / HYPERLIQUID_PRIVATE_KEY missing in .env";

  try {
    const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";

    // Build two exchange instances — one for perps, one for spot — because
    // Hyperliquid uses separate "clearinghouse" endpoints for each.
    const exPerps = new ccxt.hyperliquid({
      walletAddress: walletAddr, privateKey,
      options: { defaultType: "swap" },
    });
    const exSpot = new ccxt.hyperliquid({
      walletAddress: walletAddr, privateKey,
      options: { defaultType: "spot" },
    });
    if (useTestnet) { exPerps.setSandboxMode(true); exSpot.setSandboxMode(true); }
    await exPerps.loadMarkets();

    // Get a price map for ALL spot tokens via the native SDK (weight 2).
    // Hyperliquid's allMids returns { HYPE: "57.7", PURR: "0.18", ... }.
    // USDC is the quote currency and = $1 by definition.
    const transport  = new hl.HttpTransport({ isTestnet: useTestnet });
    const infoClient = new hl.InfoClient({ transport });
    let priceMap = {};
    try {
      const mids = await infoClient.allMids();
      for (const [sym, px] of Object.entries(mids || {})) {
        priceMap[sym] = parseFloat(px);
      }
    } catch (e) { console.warn("[HL allMids]", e.message); }
    // Convert any spot token to USDC. Hyperliquid lists spot prices keyed
    // by either the token name (e.g. "HYPE") OR the spot pair name
    // (e.g. "@107" or "PURR/USDC"). Try both.
    const priceUsdc = (ccy) => {
      if (ccy === "USDC" || ccy === "USDT") return 1;
      if (priceMap[ccy] != null) return priceMap[ccy];
      // Some pairs key as "BASE/USDC"
      if (priceMap[`${ccy}/USDC`] != null) return priceMap[`${ccy}/USDC`];
      return null;  // unknown — won't include in total
    };

    // ── PERPS USDC balance ──
    const perpBal = await exPerps.fetchBalance().catch(() => ({}));
    let perpFree = 0, perpTotal = 0;
    if (perpBal.USDC) {
      perpFree  = parseFloat(perpBal.USDC.free  || 0);
      perpTotal = parseFloat(perpBal.USDC.total || 0);
    } else if (perpBal.total?.USDC) {
      perpTotal = parseFloat(perpBal.total.USDC || 0);
      perpFree  = parseFloat(perpBal.free?.USDC || perpTotal);
    }

    // ── SPOT balances (all tokens, not just USDC) ──
    const spotBal = await exSpot.fetchBalance().catch((e) => { console.warn("[HL spot bal]", e.message); return {}; });
    const spotTokens = [];   // [{ ccy, free, total, priceUsd, valueUsd }]
    if (spotBal.total) {
      for (const [ccy, total] of Object.entries(spotBal.total)) {
        const t = parseFloat(total || 0);
        if (t > 0) {
          const px = priceUsdc(ccy);
          spotTokens.push({
            ccy,
            free   : parseFloat(spotBal.free?.[ccy] || 0),
            total  : t,
            priceUsd: px,
            valueUsd: px != null ? t * px : null,
          });
        }
      }
    }

    // ── Open perp positions (MAIN account) ──
    // Pull clearinghouseState directly — CCXT.fetchPositions filters out
    // isolated-margin positions on Hyperliquid, so the [xyz] one was missed.
    const host = useTestnet ? "api.hyperliquid-testnet.xyz" : "api.hyperliquid.xyz";
    async function hlPost(body) {
      const r = await fetch(`https://${host}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch(e) { j = text; }
      return { ok: r.ok, status: r.status, body: j };
    }

    let posLines = "";
    let unrealPnlTotal = 0;
    let perpPositionNotionalTotal = 0;

    // Refresh perpTotal/perpFree from clearinghouseState — it covers both
    // cross and isolated; CCXT's fetchBalance only sees cross.
    let mainCs = null;
    try {
      const resp = await hlPost({ type: "clearinghouseState", user: walletAddr });
      if (resp.ok && resp.body && typeof resp.body === "object") mainCs = resp.body;
      console.log(`[HL clearinghouseState] HTTP ${resp.status} — assetPositions: ${mainCs?.assetPositions?.length || 0}`);
    } catch(e) { console.warn("[HL clearinghouseState] failed:", e.message); }

    if (mainCs) {
      const acctValue = parseFloat(mainCs.marginSummary?.accountValue || 0);
      const withdraw  = parseFloat(mainCs.withdrawable || 0);
      if (acctValue > 0) perpTotal = acctValue;
      if (withdraw  > 0) perpFree  = withdraw;

      if (Array.isArray(mainCs.assetPositions)) {
        for (const ap of mainCs.assetPositions) {
          const pos = ap?.position;
          if (!pos) continue;
          const szi = parseFloat(pos.szi || 0);
          if (szi === 0) continue;
          const side = szi > 0 ? "LONG" : "SHORT";
          const uPnl = parseFloat(pos.unrealizedPnl || 0);
          const notional = parseFloat(pos.positionValue || 0);
          const mark = Math.abs(szi) > 0 ? notional / Math.abs(szi) : 0;
          const levType = pos.leverage?.type === "isolated" ? "ISO" : "CROSS";
          const levVal  = pos.leverage?.value;
          const levTag  = levVal ? `${levVal}x ${levType}` : levType;
          unrealPnlTotal += uPnl;
          perpPositionNotionalTotal += notional;
          posLines += `  📍 <code>${pos.coin}</code> ${side} ${Math.abs(szi)} @ $${mark.toFixed(4)} | Value: $${notional.toFixed(2)} | ${levTag} | uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(4)}\n`;
        }
      }
    } else {
      // Fallback: old CCXT path (only cross positions)
      let positions = [];
      try { positions = await exPerps.fetchPositions(); } catch(e) {}
      const openPositions = positions.filter(p => parseFloat(p.contracts || p.info?.szi || 0) !== 0);
      for (const p of openPositions) {
        const sz   = parseFloat(p.contracts || p.info?.szi || 0);
        const side = sz > 0 ? "LONG" : "SHORT";
        const uPnl = parseFloat(p.unrealizedPnl ?? p.info?.unrealizedPnl ?? 0);
        const baseCoin = p.symbol?.split("/")?.[0] || "";
        const midPx    = priceMap[baseCoin];
        let notional = p.info?.positionValue != null ? parseFloat(p.info.positionValue) : null;
        if (notional == null && midPx != null) notional = midPx * Math.abs(sz);
        const mark = notional != null && Math.abs(sz) > 0
          ? notional / Math.abs(sz)
          : (midPx ?? parseFloat(p.markPrice ?? p.info?.markPx ?? 0));
        unrealPnlTotal += uPnl;
        if (notional != null) perpPositionNotionalTotal += notional;
        const notionalStr = notional != null ? ` | Value: $${notional.toFixed(2)}` : "";
        posLines += `  📍 <code>${p.symbol}</code> ${side} ${Math.abs(sz)} @ $${mark.toFixed(4)}${notionalStr} | uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(4)}\n`;
      }
    }

    // ── Sub-accounts (Hyperliquid feature where a master wallet has
    // named perp sub-accounts). For most users this returns null —
    // isolated-margin positions are already covered by the main
    // clearinghouseState above. We keep this branch for users who DO
    // have true Hyperliquid sub-accounts.
    let subAccounts = [];
    try {
      const resp = await hlPost({ type: "subAccounts", user: walletAddr });
      console.log(`[HL subAccounts] HTTP ${resp.status} — response:`, JSON.stringify(resp.body).slice(0, 600));
      if (resp.ok && Array.isArray(resp.body)) subAccounts = resp.body;
    } catch(e) { console.warn("[HL subAccounts] fetch failed:", e.message); }

    console.log(`[HL portfolio] Found ${subAccounts.length} sub-account(s)`);

    for (const sub of subAccounts) {
      const subName = sub.name || sub.subAccountName || (sub.subAccountUser?.slice(0, 6) || "sub");
      const subAddr = sub.subAccountUser || sub.address || sub.user;
      console.log(`[HL subAccounts] processing "${subName}" addr=${subAddr}`);

      // Some Hyperliquid responses bundle clearinghouseState; others return
      // only addresses. If absent, fetch it explicitly for the sub-account.
      let cs = sub.clearinghouseState;
      if (!cs && subAddr) {
        try {
          const r2 = await hlPost({ type: "clearinghouseState", user: subAddr });
          if (r2.ok && r2.body && typeof r2.body === "object") cs = r2.body;
          console.log(`[HL subAccounts] fetched clearinghouseState separately for ${subName} — accountValue:`, cs?.marginSummary?.accountValue);
        } catch(e) { console.warn(`[HL subAccounts] clearinghouseState fetch for ${subName} failed:`, e.message); }
      }
      if (!cs) { console.warn(`[HL subAccounts] no clearinghouseState for ${subName} — skipped`); continue; }

      const subAccountValue = parseFloat(cs.marginSummary?.accountValue || 0);
      const subWithdrawable = parseFloat(cs.withdrawable || 0);
      perpFree  += subWithdrawable;
      perpTotal += subAccountValue;

      if (Array.isArray(cs.assetPositions)) {
        for (const ap of cs.assetPositions) {
          const pos = ap?.position;
          if (!pos) continue;
          const szi = parseFloat(pos.szi || 0);
          if (szi === 0) continue;
          const side = szi > 0 ? "LONG" : "SHORT";
          const uPnl = parseFloat(pos.unrealizedPnl || 0);
          const notional = parseFloat(pos.positionValue || 0);
          const mark = Math.abs(szi) > 0 ? notional / Math.abs(szi) : 0;
          unrealPnlTotal += uPnl;
          perpPositionNotionalTotal += notional;
          posLines += `  📍 [<code>${subName}</code>] <code>${pos.coin}</code> ${side} ${Math.abs(szi)} @ $${mark.toFixed(4)} | Value: $${notional.toFixed(2)} | uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(4)}\n`;
        }
      }
    }

    if (!posLines) posLines = "  (no open positions)\n";

    // ── Format spot section + compute spot USDC TOTAL value (all tokens) ──
    let spotLines = "";
    let spotUsdTotal = 0;
    let spotUnknownTokens = [];
    if (spotTokens.length === 0) {
      spotLines = "  (no spot balances)\n";
    } else {
      for (const t of spotTokens) {
        if (t.valueUsd != null) {
          spotUsdTotal += t.valueUsd;
          const priceTag = t.ccy === "USDC" ? "" : ` × $${t.priceUsd.toFixed(4)}`;
          spotLines += `  <code>${t.ccy.padEnd(6)}</code> ${t.total.toFixed(4)}${priceTag} = <b>$${t.valueUsd.toFixed(2)}</b>\n`;
        } else {
          spotUnknownTokens.push(t.ccy);
          spotLines += `  <code>${t.ccy.padEnd(6)}</code> ${t.total.toFixed(4)} <i>(no price found — excluded)</i>\n`;
        }
      }
    }

    // ── COMBINED — everything in USDT-equivalent ──
    // Perps USDC collateral + spot tokens + notional value of open perp positions
    const combinedUsd = perpTotal + spotUsdTotal + perpPositionNotionalTotal;

    const envTag = useTestnet ? "🧪 TESTNET" : "🟢 MAINNET";
    const unknownNote = spotUnknownTokens.length > 0
      ? `\n<i>⚠ No price for: ${spotUnknownTokens.join(", ")} — not in total</i>`
      : "";
    const positionLine = perpPositionNotionalTotal > 0
      ? `\n   Positions: $${perpPositionNotionalTotal.toFixed(2)} (notional)`
      : "";
    return `<b>💼 🟣 Hyperliquid Portfolio</b> ${envTag}
<i>${new Date().toLocaleString()}</i>
Wallet: <code>${walletAddr.slice(0,10)}...${walletAddr.slice(-6)}</code>

━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>Perps Account</b>
  Free  USDC: <b>$${perpFree.toFixed(2)}</b>
  Total USDC: <b>$${perpTotal.toFixed(2)}</b>
  Unrealized PnL: <b>${unrealPnlTotal>=0?"+":""}$${unrealPnlTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
🪙 <b>Spot Account</b> (all tokens valued in USDC)
${spotLines}  Spot total: <b>$${spotUsdTotal.toFixed(2)}</b>${unknownNote}

━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Open Perp Positions</b>
${posLines}
━━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>TOTAL (USDT-equivalent): $${combinedUsd.toFixed(2)}</b>
   Perps:     $${perpTotal.toFixed(2)}
   Spot:      $${spotUsdTotal.toFixed(2)}${positionLine}`;

  } catch(err) {
    return `❌ Hyperliquid portfolio fetch failed:\n<code>${err.message}</code>`;
  }
}

// ============================================================
//  RESTART HANDLER (per exchange)
// ============================================================

// ─────────────────────────────────────────────────────────────
// Restart a bot via Telegram. Works in TWO modes:
//   A) "Quick restart" — prev config exists → tweak just spacings/qty/dist
//      (the legacy 5-numbers flow used by the menu buttons)
//   B) "Cold launch"   — no prev config → user MUST supply full params:
//      sellSpread buySpread targetSpread qty distance  priceSource symbol
//      (8 values total)
// Either way: no UI is required. Frontend just shows the running state.
// ─────────────────────────────────────────────────────────────
async function tgDoRestart(chatId, exchangeKey, sellSpread, buySpread, targetSpread, qty, distance, priceSource, symbol) {
  const bot = bots[exchangeKey];
  const tag = EXCHANGE_TAG[exchangeKey];
  const prev = bot.config;

  // If no prev config, the caller MUST have given priceSource + symbol
  if (!prev && (!priceSource || !symbol)) {
    await tgSend(chatId,
      `❌ <b>${tag}: no previous config in memory</b>\n\n` +
      `Send <b>7 values</b> to launch fresh:\n` +
      `<code>sellSpread buySpread targetSpread qty distance priceSource symbol</code>\n\n` +
      `<b>Examples:</b>\n` +
      `Hyperliquid perp HYPE:\n<code>0.05 0.05 0.05 1 2 hyperliquid HYPE/USDC:USDC</code>\n\n` +
      `Hyperliquid spot HYPE:\n<code>0.05 0.05 0.05 0.3 1 hyperliquid_spot HYPE/USDC</code>\n\n` +
      `Binance spot SOL/FDUSD:\n<code>0.25 0.25 0.5 1.166 5 binance_spot SOL/FDUSD</code>`,
      mainMenu());
    return;
  }

  await tgSend(chatId,
    `⏳ ${prev ? "Restarting" : "Launching"} ${tag}...\n\n` +
    `Sell : <code>$${sellSpread}</code>\nBuy  : <code>$${buySpread}</code>\n` +
    `Target: <code>$${targetSpread}</code>\nQty   : <code>${qty}</code>\nDist  : <code>$${distance}</code>` +
    (prev ? "" : `\nSrc  : <code>${priceSource}</code>\nSym  : <code>${symbol}</code>`)
  );

  // Stop the previous session if running
  if (bot.running) {
    clearInterval(bot.loopTimer); bot.running = false;
    try{ await cancelAllOrders(exchangeKey); } catch(e){}
    log(exchangeKey, "Telegram restart: stopped previous session", "warn");
  }

  // Build cfg — either patch prev, or build from scratch
  const cfg = prev ? {
    ...prev,
    avgSellSpacing : parseFloat(sellSpread),
    avgBuySpacing  : parseFloat(buySpread),
    targetSpread   : parseFloat(targetSpread),
    qtyPerStep     : parseFloat(qty),
    distance       : parseFloat(distance),
  } : {
    priceSource    : priceSource,
    symbol         : symbol,
    avgSellSpacing : parseFloat(sellSpread),
    avgBuySpacing  : parseFloat(buySpread),
    targetSpread   : parseFloat(targetSpread),
    qtyPerStep     : parseFloat(qty),
    distance       : parseFloat(distance),
    telegramToken  : process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId : process.env.TELEGRAM_CHAT_ID,
  };
  injectKeysIntoCfg(exchangeKey, cfg);

  if (!cfg.apiKey || !cfg.secretKey) {
    const which = exchangeKey === "deribit"     ? "DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET"
                : exchangeKey === "hyperliquid" ? "HYPERLIQUID_WALLET_ADDRESS / HYPERLIQUID_PRIVATE_KEY"
                                                : "BINANCE_API_KEY / BINANCE_SECRET_KEY";
    await tgSend(chatId, `❌ ${tag}: <code>${which}</code> missing in .env`, mainMenu());
    return;
  }

  try {
    const exchange = buildExchange(cfg.priceSource, cfg.apiKey, cfg.secretKey);
    await exchange.loadMarkets();
    if (exchangeKey === "binance") await syncExchangeTime(exchange);

    // Pre-warm Hyperliquid native SDK before ticker fetch
    if (exchangeKey === "hyperliquid") {
      try {
        const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
        const wallet     = privateKeyToAccount(process.env.HYPERLIQUID_PRIVATE_KEY);
        const transport  = new hl.HttpTransport({ isTestnet: useTestnet });
        const exchClient = new hl.ExchangeClient({ wallet, transport, isTestnet: useTestnet });
        const infoClient = new hl.InfoClient({ transport });
        const isSpot = (cfg.priceSource === "hyperliquid_spot");
        const base   = cfg.symbol.split("/")[0];
        let assetIndex = -1, szDecimals = 4, maxSig = 5, coinId = base;
        if (isSpot) {
          const m = await infoClient.spotMeta();
          for (let i = 0; i < m.universe.length; i++) {
            const baseToken = m.tokens[m.universe[i].tokens[0]];
            if (baseToken?.name === base) {
              assetIndex = 10000 + m.universe[i].index;
              szDecimals = baseToken.szDecimals ?? 4; maxSig = 8;
              coinId = m.universe[i].name; break;
            }
          }
        } else {
          const m = await infoClient.meta();
          for (let i = 0; i < m.universe.length; i++) {
            if (m.universe[i].name === base) {
              assetIndex = i; szDecimals = m.universe[i].szDecimals ?? 4;
              maxSig = 5; coinId = m.universe[i].name; break;
            }
          }
        }
        if (assetIndex < 0) throw new Error(`Asset ${base} not found`);
        bot.hlCache = { exchClient, infoClient, assetIndex, base, coinId, szDecimals, maxSig, isSpot };
        bot.exchange = exchange;
      } catch (e) {
        log(exchangeKey, `Hyperliquid SDK prewarm failed: ${e.message}`, "warn");
      }
    }

    const tick       = await getTickerSnapshot(exchange, cfg.symbol, 15000, bot);
    const entryPrice = tick.last;
    const upperLimit = parseFloat((entryPrice + cfg.distance).toFixed(8));
    const lowerLimit = parseFloat((entryPrice - cfg.distance).toFixed(8));

    Object.assign(bot, {
      botId: exchangeKey, exchangeKey,
      config: cfg, exchange, entryPrice, lastPrice: entryPrice,
      bestBid: tick.bid, bestAsk: tick.ask,
      upperLimit, lowerLimit, running: true, startedAt: Date.now(), openOrders: [],
      fillHistory: [], pendingRoundTrips: [], completedRoundTrips: [],
      logs: [], loopCount: 0, lastNotifiedRt: 0, gridAnchor: null,
    });

    try { await exchange.cancelAllOrders(cfg.symbol); }
    catch(e) {
      try {
        const p2 = await exchange.fetchOpenOrders(cfg.symbol);
        for (const o of p2) { try{ await exchange.cancelOrder(o.id, cfg.symbol); }catch(_){} }
      } catch(_){}
    }

    await maintainGrid(exchangeKey, entryPrice);
    const runningCount = listBots().filter(b => b.running).length;
    const loopMs = runningCount <= 1 ? 4000 : runningCount === 2 ? 5000 : runningCount === 3 ? 7000 : 9000;
    bot.loopTimer = setInterval(() => gridLoop(exchangeKey), loopMs);
    log(exchangeKey, `Telegram ${prev ? "restart" : "launch"}: RUNNING | Entry $${entryPrice} | ${cfg.symbol}`, "success");
    broadcast("state", buildStateSnapshot());

    await tgSend(chatId,
      `✅ <b>${tag} ${prev ? "Restarted" : "Launched"}!</b>\n\n` +
      `Symbol: <code>${cfg.symbol}</code>\n` +
      `Entry : <code>$${entryPrice.toFixed(4)}</code>\n` +
      `Upper : <code>$${upperLimit.toFixed(4)}</code>\n` +
      `Lower : <code>$${lowerLimit.toFixed(4)}</code>\n` +
      `Log   : <code>logs/${exchangeKey}.log</code>`,
      mainMenu()
    );
  } catch(err) {
    log(exchangeKey, `Telegram ${prev ? "restart" : "launch"} failed: ${err.message}`, "error");
    await tgSend(chatId, `❌ ${tag} ${prev ? "Restart" : "Launch"} failed:\n<code>${err.message}</code>`, mainMenu());
  }
}

// ============================================================
//  TELEGRAM UPDATE HANDLER
// ============================================================
async function handleTgUpdate(update) {
  const allowedId = String(process.env.TELEGRAM_CHAT_ID || "");

  if (update.callback_query) {
    const cb     = update.callback_query;
    const fromId = String(cb.from?.id || "");
    const msgId  = cb.message?.message_id;
    if (allowedId && fromId !== allowedId) { await tgAck(cb.id, "Unauthorized"); return; }
    await tgAck(cb.id);
    const data = cb.data || "";

    if (data === "main_menu") {
      await tgEdit(fromId, msgId,
        `👋 <b>Grid Bot Control Panel</b>\n\n🟦 Binance: <b>${bots.binance.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n🟧 Deribit: <b>${bots.deribit.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n\nChoose an action:`,
        mainMenu());
      return;
    }
    if (data.startsWith("act_")) {
      const action = data.slice(4);
      if (action === "help") { await tgEdit(fromId, msgId, tgHelpText(), mainMenu()); return; }
      await tgEdit(fromId, msgId, `Pick an exchange for <b>${action.toUpperCase()}</b>:`, exchangeSelectorMenu(action));
      return;
    }
    if (data.startsWith("pick_")) {
      const [, exch, action] = data.split("_");
      if (!bots[exch]) { await tgEdit(fromId, msgId, "Unknown exchange.", mainMenu()); return; }
      await runExchangeAction(fromId, msgId, exch, action);
      return;
    }
    if (data.startsWith("do_")) {
      const [, action, exch] = data.split("_");
      if (!bots[exch]) { await tgEdit(fromId, msgId, "Unknown exchange.", mainMenu()); return; }
      await runExchangeAction(fromId, msgId, exch, action);
      return;
    }
    if (data === "cancel_restart") {
      delete tgConv[fromId];
      await tgEdit(fromId, msgId, "❌ Restart cancelled.", mainMenu());
      return;
    }
    await tgEdit(fromId, msgId, "Unknown action.", mainMenu());
    return;
  }

  if (update.message) {
    const msg    = update.message;
    const fromId = String(msg.chat?.id || "");
    const text   = (msg.text || "").trim();
    if (allowedId && fromId !== allowedId) return;

    const conv = tgConv[fromId];
    if (conv?.step === "awaiting_params" && !text.startsWith("/")) {
      const parts = text.trim().split(/\s+/);
      const exch = conv.exchangeKey;
      const prev = bots[exch]?.config;
      // Two valid shapes:
      //   5 values (numbers): sell buy target qty distance  → needs prev config
      //   7 values: sell buy target qty distance priceSource symbol → cold launch
      if (parts.length === 5) {
        const nums = parts.map(Number);
        if (nums.some(isNaN) || nums.some(v => v <= 0)) {
          await tgSend(fromId,
            `❌ Need <b>5 positive numbers</b>:\n<code>sellSpread buySpread targetSpread qty distance</code>\n\n` +
            `Or send <b>7 values</b> for a fresh start (no UI needed):\n<code>sell buy target qty distance priceSource symbol</code>\n\n` +
            `Example (HL perp HYPE):\n<code>0.05 0.05 0.05 1 2 hyperliquid HYPE/USDC:USDC</code>`,
            [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
          return;
        }
        if (!prev) {
          await tgSend(fromId,
            `❌ <b>${EXCHANGE_TAG[exch]}: no previous config</b>\n\n` +
            `Send <b>7 values</b> to launch fresh:\n` +
            `<code>sell buy target qty distance priceSource symbol</code>\n\n` +
            `<b>Examples:</b>\n` +
            `HL perp:    <code>0.05 0.05 0.05 1 2 hyperliquid HYPE/USDC:USDC</code>\n` +
            `HL spot:    <code>0.05 0.05 0.05 0.3 1 hyperliquid_spot HYPE/USDC</code>\n` +
            `Binance:    <code>0.25 0.25 0.5 1.166 5 binance_spot SOL/FDUSD</code>`,
            [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
          return;
        }
        delete tgConv[fromId];
        const [ss, bs, ts, q, dist] = nums;
        await tgDoRestart(fromId, exch, ss, bs, ts, q, dist);
        return;
      }
      if (parts.length === 7) {
        const [ssRaw, bsRaw, tsRaw, qRaw, distRaw, priceSource, symbol] = parts;
        const ss = parseFloat(ssRaw), bs = parseFloat(bsRaw), ts = parseFloat(tsRaw);
        const q  = parseFloat(qRaw),  dist = parseFloat(distRaw);
        if ([ss, bs, ts, q, dist].some(v => isNaN(v) || v <= 0)) {
          await tgSend(fromId, `❌ First 5 values must be positive numbers.`,
            [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
          return;
        }
        if (!priceSource || !symbol) {
          await tgSend(fromId, `❌ priceSource and symbol are required as the 6th and 7th values.`,
            [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
          return;
        }
        delete tgConv[fromId];
        await tgDoRestart(fromId, exch, ss, bs, ts, q, dist, priceSource, symbol);
        return;
      }
      await tgSend(fromId,
        `❌ Send either <b>5</b> or <b>7</b> values.\n\n` +
        `<b>5 numbers</b> (uses existing config):\n<code>sell buy target qty distance</code>\n\n` +
        `<b>7 values</b> (fresh launch, no UI):\n<code>sell buy target qty distance priceSource symbol</code>\n\n` +
        `Example: <code>0.05 0.05 0.05 1 2 hyperliquid HYPE/USDC:USDC</code>`,
        [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
      return;
    }

    const cmd = text.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/menu":
        await tgSend(fromId,
          `👋 <b>Grid Bot Control Panel</b>\n\n🟦 Binance: <b>${bots.binance.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n🟧 Deribit: <b>${bots.deribit.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n🟣 Hyperliquid: <b>${bots.hyperliquid.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n\nChoose an action:`,
          mainMenu()); break;
      case "/status":    await tgSend(fromId, "Pick an exchange:", exchangeSelectorMenu("status")); break;
      case "/portfolio": await tgSend(fromId, "Pick an exchange:", exchangeSelectorMenu("portfolio")); break;
      case "/report":    await tgSend(fromId, "Pick an exchange:", exchangeSelectorMenu("report")); break;
      case "/csv":       await tgSend(fromId, "Pick an exchange for 24h CSV:", exchangeSelectorMenu("csv")); break;
      case "/restart":   await tgSend(fromId, "Pick an exchange to restart:", exchangeSelectorMenu("restart")); break;
      case "/stop":      await tgSend(fromId, "Pick an exchange to stop:", exchangeSelectorMenu("stop")); break;
      case "/help":      await tgSend(fromId, tgHelpText(), mainMenu()); break;
      default:
        if (!conv) await tgSend(fromId, "Use /menu, /restart, or tap the buttons:", mainMenu());
    }
  }
}

async function runExchangeAction(chatId, msgId, exchangeKey, action) {
  const bot = bots[exchangeKey];
  const tag = EXCHANGE_TAG[exchangeKey];

  switch (action) {
    case "status":
      await tgEdit(chatId, msgId, tgStatusText(exchangeKey), exchangeMenu(exchangeKey));
      return;
    case "portfolio": {
      await tgEdit(chatId, msgId, `⏳ Fetching ${tag} balances...`, null);
      let txt;
      if (exchangeKey === "binance")          txt = await tgBinancePortfolioText();
      else if (exchangeKey === "hyperliquid") txt = await tgHyperliquidPortfolioText();
      else                                    txt = await tgDeribitPortfolioText();
      await tgEdit(chatId, msgId, txt, exchangeMenu(exchangeKey));
      return;
    }
    case "report":
      await tgEdit(chatId, msgId, "⏳ Computing report...", null);
      if (exchangeKey === "deribit") await refreshDeribitFees().catch(()=>{});
      await tgEdit(chatId, msgId, tgReportText(exchangeKey), exchangeMenu(exchangeKey));
      return;
    case "csv": {
      await tgEdit(chatId, msgId, `⏳ Building 24h CSV for ${tag}...`, null);
      if (exchangeKey === "deribit") await refreshDeribitFees().catch(()=>{});
      const now    = Date.now();
      const fromTs = now - 24 * 60 * 60 * 1000;
      const csv    = buildCsvReport(exchangeKey, fromTs, now);
      const dateStr = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const filename = `gridbot_${exchangeKey}_24h_${dateStr}.csv`;
      const r        = getRoundTripReport(exchangeKey, fromTs, now);
      const caption  = `📥 <b>${tag} 24h CSV Report</b>\n\nRound trips: <b>${r.count}</b>\nTotal PnL: <b>$${r.pnl.toFixed(4)}</b>\nSymbol: <code>${bot.config?.symbol || "—"}</code>`;
      const result   = await tgSendDocument(chatId, filename, Buffer.from(csv, "utf8"), caption);
      if (result?.ok) {
        await tgEdit(chatId, msgId, `✅ ${tag} CSV sent.`, exchangeMenu(exchangeKey));
      } else {
        const err = result?.description || "unknown";
        await tgEdit(chatId, msgId, `❌ Failed to send CSV: <code>${err}</code>`, exchangeMenu(exchangeKey));
      }
      return;
    }
    case "stop":
      if (!bot.running) {
        await tgEdit(chatId, msgId, `ℹ️ ${tag} is already stopped.`, exchangeMenu(exchangeKey));
        return;
      }
      clearInterval(bot.loopTimer); bot.running = false;
      try { await cancelAllOrders(exchangeKey); } catch(e){}
      db.clearSession(exchangeKey);
      log(exchangeKey, "Telegram stop", "warn");
      broadcast("state", buildStateSnapshot());
      await tgEdit(chatId, msgId,
        `🛑 <b>${tag} Stopped</b>\n\nSymbol: <code>${bot.config?.symbol||"—"}</code>\nLast Price: <code>$${bot.lastPrice||"—"}</code>\nTime: ${new Date().toLocaleString()}`,
        exchangeMenu(exchangeKey));
      return;
    case "restart":
      tgConv[chatId] = { step: "awaiting_params", exchangeKey };
      await tgEdit(chatId, msgId, restartPromptText(exchangeKey, bot.config),
        [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
      return;
    default:
      await tgEdit(chatId, msgId, "Unknown action.", mainMenu());
  }
}

function startTelegramPoller() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.log("[TG POLLER] Skipped — TELEGRAM_BOT_TOKEN not in .env"); return; }
  console.log("[TG POLLER] Started — polling every 2 s");
  tgPost("setMyCommands", { commands: [
    {command:"menu",      description:"Show control panel"},
    {command:"status",    description:"Bot status (pick exchange)"},
    {command:"portfolio", description:"Portfolio (pick exchange)"},
    {command:"report",    description:"PnL report (pick exchange)"},
    {command:"csv",       description:"Download 24h CSV (pick exchange)"},
    {command:"restart",   description:"Restart bot (pick exchange)"},
    {command:"stop",      description:"Stop bot (pick exchange)"},
    {command:"help",      description:"Help"},
  ]}).catch(()=>{});

  const poll = () => {
    const path = `/bot${token}/getUpdates?offset=${tgOffset}&timeout=1&allowed_updates=message,callback_query`;
    https.get({host:"api.telegram.org", path, headers:{"User-Agent":"node"}}, (res) => {
      let raw=""; res.on("data",c=>raw+=c);
      res.on("end", async () => {
        try {
          const data = JSON.parse(raw);
          if (data.ok && Array.isArray(data.result)) {
            for (const upd of data.result) {
              tgOffset = upd.update_id + 1;
              handleTgUpdate(upd).catch(e => console.error("[TG POLLER] err:", e.message));
            }
          }
        } catch(_){}
      });
    }).on("error", () => {});
  };
  setInterval(poll, 2000);
}

// ============================================================
//  HELPERS — broadcast, log
// ============================================================
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function log(botId, msg, level = "info") {
  const bot = bots[botId];
  const exch = bot?.exchangeKey || botId;
  const baseTag = EXCHANGE_TAG[exch] || exch;
  const isLegacy = (botId === "binance" || botId === "deribit" || botId === "hyperliquid");
  const tag = isLegacy ? baseTag : `${baseTag}#${botId}`;
  const ts = new Date().toISOString();
  const entry = { exchangeKey: bot?.exchangeKey || botId, botId, msg: `[${tag}] ${msg}`, level, ts };
  if (bot) {
    bot.logs.unshift(entry);
    if (bot.logs.length > 200) bot.logs.pop();
  }
  broadcast("log", entry);
  console.log(`[${String(botId).toUpperCase()}/${level.toUpperCase()}] ${msg}`);
  // Per-bot log file (so `tail -f logs/<botId>.log` shows only this bot)
  try {
    getLogStream(botId).write(`${ts}  [${level.toUpperCase().padEnd(7)}] ${msg}\n`);
  } catch (e) { /* never let logging break the bot */ }
}

// ============================================================
//  ROUND HELPERS
// ============================================================
function roundPrice(price, tickSize) {
  if (!tickSize) return parseFloat(price.toFixed(8));
  const decimals = (tickSize.toString().split(".")[1] || "").length;
  return parseFloat(price.toFixed(decimals));
}
function roundQty(qty, stepSize) {
  if (!stepSize) return parseFloat(qty.toFixed(8));
  const decimals = (stepSize.toString().split(".")[1] || "").length;
  return parseFloat(qty.toFixed(decimals));
}

// Format milliseconds → "1d 3h 24m" / "2h 18m" / "47m 13s" / "9s"
function formatDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s  = Math.floor(ms / 1000);
  const d  = Math.floor(s / 86400);
  const h  = Math.floor((s % 86400) / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

// ============================================================
//  EXCHANGE BUILDER
// ============================================================
function buildExchange(priceSource, apiKey, secretKey) {
  const baseCreds = {
    apiKey, secret: secretKey,
    adjustForTimeDifference: false,
    recvWindow: 60000,
    options: { recvWindow: 60000, fetchCurrencies: false, defaultType: "spot" },
  };
  const stripCurrencies = (ex) => {
    ex.fetchCurrencies = async () => ({});
    ex.currencies = {}; ex.currencies_by_id = {};
    return ex;
  };

  // Set BINANCE_TESTNET=true in .env to route Binance traffic to:
  //   Spot: testnet.binance.vision   |   USDM: testnet.binancefuture.com
  // Coin-M Futures has NO official Binance testnet, so we warn and stay on prod.
  const binanceTestnet = String(process.env.BINANCE_TESTNET || "").toLowerCase() === "true";

  if (priceSource === "binance_futures") {
    const ex = stripCurrencies(new ccxt.binanceusdm({ ...baseCreds, options:{...baseCreds.options, defaultType:"future"} }));
    if (binanceTestnet) { ex.setSandboxMode(true); console.log("[BINANCE USDM] 🧪 Using TESTNET (testnet.binancefuture.com)"); }
    else                { console.log("[BINANCE USDM] 🟢 Using PRODUCTION (fapi.binance.com)"); }
    return ex;
  }
  if (priceSource === "binance_coinm") {
    const ex = stripCurrencies(new ccxt.binancecoinm({ ...baseCreds, options:{...baseCreds.options, defaultType:"delivery"} }));
    if (binanceTestnet) {
      console.warn("[BINANCE COIN-M] ⚠️ Binance does NOT operate a Coin-M testnet. Staying on PRODUCTION (dapi.binance.com).");
      console.warn("[BINANCE COIN-M] To test the bot logic, switch priceSource to Binance Spot or Binance Futures (USDT-M).");
    } else {
      console.log("[BINANCE COIN-M] 🟢 Using PRODUCTION (dapi.binance.com)");
    }
    return ex;
  }
  if (priceSource === "deribit" || priceSource === "deribit_spot") {
    const isSpot = priceSource === "deribit_spot";
    const ex = new ccxt.deribit({
      apiKey, secret: secretKey,
      options: { defaultType: isSpot ? "spot" : "swap" },
    });
    // Set DERIBIT_TESTNET=true in .env to use test.deribit.com
    // (testnet has its own separate accounts + API keys)
    const useTestnet = String(process.env.DERIBIT_TESTNET || "").toLowerCase() === "true";
    if (useTestnet) {
      ex.setSandboxMode(true);
      console.log(`[DERIBIT ${isSpot ? "SPOT" : "PERP"}] 🧪 Using TESTNET (test.deribit.com)`);
    } else {
      console.log(`[DERIBIT ${isSpot ? "SPOT" : "PERP"}] 🟢 Using PRODUCTION (www.deribit.com)`);
    }
    return ex;
  }
  if (priceSource === "hyperliquid" || priceSource === "hyperliquid_spot" || priceSource === "hyperliquid_hip3") {
    // Hyperliquid uses wallet-based auth: walletAddress (your main wallet's
    // public address) + privateKey (the API Wallet's private key — NOT your
    // main wallet's key). The API wallet can place orders but cannot withdraw.
    const isSpot = priceSource === "hyperliquid_spot";
    const isHip3 = priceSource === "hyperliquid_hip3";

    const ex = new ccxt.hyperliquid({
      walletAddress : apiKey,    // ← we abuse the apiKey slot to carry walletAddress
      privateKey    : secretKey, // ← and secretKey slot to carry privateKey
      options: { defaultType: isSpot ? "spot" : "swap" },
    });

    const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
    if (useTestnet) {
      ex.setSandboxMode(true);
      console.log(`[HYPERLIQUID ${isSpot ? "SPOT" : isHip3 ? "HIP-3" : "PERP"}] 🧪 Using TESTNET (api.hyperliquid-testnet.xyz)`);
    } else {
      console.log(`[HYPERLIQUID ${isSpot ? "SPOT" : isHip3 ? "HIP-3" : "PERP"}] 🟢 Using PRODUCTION (api.hyperliquid.xyz)`);
    }

    if (isHip3) {
      console.warn("[HYPERLIQUID HIP-3] HIP-3 markets require a 'dex' parameter on each order. Not yet supported by this bot — falling back to perpetuals.");
    }
    return ex;
  }
  // Default: Binance Spot
  const ex = stripCurrencies(new ccxt.binance(baseCreds));
  if (binanceTestnet) { ex.setSandboxMode(true); console.log("[BINANCE SPOT] 🧪 Using TESTNET (testnet.binance.vision)"); }
  else                { console.log("[BINANCE SPOT] 🟢 Using PRODUCTION (api.binance.com)"); }
  return ex;
}

function injectKeysIntoCfg(exchangeKey, cfg) {
  if (exchangeKey === "deribit") {
    cfg.apiKey    = process.env.DERIBIT_CLIENT_ID;
    cfg.secretKey = process.env.DERIBIT_CLIENT_SECRET;
  } else if (exchangeKey === "hyperliquid") {
    // Hyperliquid uses walletAddress + privateKey, stored in the apiKey/secretKey slots
    cfg.apiKey    = process.env.HYPERLIQUID_WALLET_ADDRESS;
    cfg.secretKey = process.env.HYPERLIQUID_PRIVATE_KEY;
  } else {
    cfg.apiKey    = process.env.BINANCE_API_KEY;
    cfg.secretKey = process.env.BINANCE_SECRET_KEY;
  }
  cfg.telegramToken  = process.env.TELEGRAM_BOT_TOKEN;
  cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID;
}

// ============================================================
//  TIME SYNC (Binance only)
// ============================================================
async function syncExchangeTime(exchange) {
  try {
    const isUsdm  = exchange.id === "binanceusdm";
    const isCoinm = exchange.id === "binancecoinm";
    const path    = isUsdm ? "/fapi/v1/time" : isCoinm ? "/dapi/v1/time" : "/api/v3/time";
    // Use testnet host if BINANCE_TESTNET=true (and Coin-M stays on prod since
    // there's no Coin-M testnet)
    const binanceTestnet = String(process.env.BINANCE_TESTNET || "").toLowerCase() === "true";
    let host;
    if (binanceTestnet && isUsdm)        host = "testnet.binancefuture.com";
    else if (binanceTestnet && !isCoinm) host = "testnet.binance.vision";
    else if (isUsdm)                     host = "fapi.binance.com";
    else if (isCoinm)                    host = "dapi.binance.com";
    else                                 host = "api.binance.com";
    const serverTime = await new Promise((resolve, reject) => {
      https.get({host, path, headers:{"User-Agent":"node"}}, (res) => {
        let raw=""; res.on("data",c=>raw+=c);
        res.on("end",()=>{ try{resolve(JSON.parse(raw).serverTime)}catch(e){reject(e)} });
      }).on("error", reject);
    });
    const offset = serverTime - Date.now();
    exchange.timeDifference = offset;
    exchange.options.timeDifference = offset;
    exchange.nonce = () => Date.now() + offset;
    exchange.milliseconds = () => Date.now() + offset;
    console.log(`[TIME SYNC] ${exchange.id} via ${host} offset=${offset}ms`);
  } catch (err) {
    console.warn("[TIME SYNC] Failed:", err.message);
  }
}

async function getCurrentPrice(exchange, symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last;
}

// Returns { last, bid, ask } in one shot.
// We use bid/ask to clamp post_only orders (Deribit rejects post-only orders
// that would cross the spread with code 11054 "post_only_reject").
// Native Hyperliquid ticker — bypasses CCXT's broken fetchTicker for Hyperliquid.
// Uses l2Book (weight 2, fast). bot.hlCache must be pre-warmed.
async function hyperliquidNativeTicker(bot, timeoutMs = 5000) {
  const cache = bot.hlCache;
  if (!cache?.infoClient || !cache.coinId) {
    throw new Error("Hyperliquid SDK not initialized");
  }
  const book = await Promise.race([
    cache.infoClient.l2Book({ coin: cache.coinId }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`l2Book timeout ${timeoutMs/1000}s`)), timeoutMs)),
  ]);
  // book.levels = [bids[], asks[]]; each level = { px, sz, n }
  const bids = book?.levels?.[0] || [];
  const asks = book?.levels?.[1] || [];
  const bestBid = bids.length ? parseFloat(bids[0].px) : null;
  const bestAsk = asks.length ? parseFloat(asks[0].px) : null;
  if (bestBid == null && bestAsk == null) throw new Error("l2Book empty book");
  const mid = (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2
            : (bestBid ?? bestAsk);
  return { last: mid, bid: bestBid ?? mid, ask: bestAsk ?? mid };
}

async function getTickerSnapshot(exchange, symbol, timeoutMs = 15000, bot = null) {
  // Hyperliquid fast path: use native SDK (CCXT's fetchTicker is broken for HL)
  if (bot && bot.exchangeKey === "hyperliquid" && bot.hlCache) {
    return await hyperliquidNativeTicker(bot, Math.min(timeoutMs, 6000));
  }
  const ticker = await Promise.race([
    exchange.fetchTicker(symbol),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`fetchTicker timeout ${timeoutMs/1000}s`)), timeoutMs)),
  ]);
  return {
    last: ticker.last,
    bid : ticker.bid || ticker.last,
    ask : ticker.ask || ticker.last,
  };
}

async function getMarketInfo(exchange, symbol) {
  await exchange.loadMarkets();
  const market   = exchange.market(symbol);
  const tickSize = market.precision?.price  || 0.01;
  const stepSize = market.precision?.amount || 0.001;
  return { tickSize, stepSize, market };
}

// ============================================================
//  EMERGENCY STOP (per exchange)
// ============================================================
async function emergencyStop(botId, reason) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  if (!bot.running) return;
  clearInterval(bot.loopTimer);
  bot.running = false;
  log(botId, `EMERGENCY STOP: ${reason}`, "error");
  try { await cancelAllOrders(botId); } catch(e){}
  db.clearSession(botId);

  const cfg = bot.config;
  if (cfg?.telegramToken && cfg?.telegramChatId) {
    const tag = EXCHANGE_TAG[exchangeKey];
    await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
      `${tag} GRID BOT STOPPED\n\nSymbol: ${cfg.symbol}\nReason: ${reason}\nLast Price: $${bot.lastPrice}\nUpper Limit: $${bot.upperLimit}\nLower Limit: $${bot.lowerLimit}\nTime: ${new Date().toLocaleString()}`
    );
  }
  broadcast("state", buildStateSnapshot());
}

// ============================================================
//  GRID LOOP (per exchange)
// ============================================================
async function gridLoop(botId) {
  const bot = bots[botId];
  if (!bot || !bot.running) return;
  const exchangeKey = bot.exchangeKey;

  // ── RE-ENTRANCY GUARD ──
  // If a previous loop iteration is still running (e.g. an API call is
  // hanging), DROP this iteration. Without this, setInterval keeps firing
  // new loops while old ones are stuck waiting for HTTP responses — each
  // holding promises and request buffers → memory leak → OOM crash.
  if (bot._loopBusy) {
    bot._missedLoops = (bot._missedLoops || 0) + 1;
    if (bot._missedLoops === 1 || bot._missedLoops % 10 === 0) {
      log(botId, `⚠ Previous loop still running — skipping this tick (${bot._missedLoops} skipped total)`, "warn");
    }
    return;
  }
  bot._loopBusy = true;

  // Rate-limit backoff: if we recently hit 429, skip this cycle entirely
  if (bot.rateLimitUntil && Date.now() < bot.rateLimitUntil) {
    bot._loopBusy = false;
    return;
  }

  try {
    // One ticker fetch per loop — 8s timeout (re-entrancy guard handles stacking)
    // Pass bot so Hyperliquid uses native SDK (CCXT fetchTicker is broken for HL)
    const tick = await getTickerSnapshot(bot.exchange, bot.config.symbol, 8000, bot);
    const currentPrice = tick.last;
    bot.lastPrice = currentPrice;
    bot.bestBid   = tick.bid;
    bot.bestAsk   = tick.ask;

    if (currentPrice >= bot.upperLimit) {
      await emergencyStop(botId, `Price $${currentPrice} reached UPPER LIMIT $${bot.upperLimit}`);
      return;
    }
    if (currentPrice <= bot.lowerLimit) {
      await emergencyStop(botId, `Price $${currentPrice} reached LOWER LIMIT $${bot.lowerLimit}`);
      return;
    }

    bot.loopCount = (bot.loopCount || 0) + 1;

    // ── MEMORY CAP ── Trim long-running arrays so multi-hour sessions
    // don't accumulate unbounded data and crash with OOM (heap ~2GB).
    if (bot.fillHistory.length > 500)         bot.fillHistory.length = 500;
    if (bot.completedRoundTrips.length > 500) bot.completedRoundTrips.length = 500;
    if (bot.logs.length > 200)                bot.logs.length = 200;
    if (bot.recentlyCancelled) {
      // Purge entries older than 5 minutes
      const cutoff = Date.now() - 5 * 60_000;
      for (const id of Object.keys(bot.recentlyCancelled)) {
        if (bot.recentlyCancelled[id] < cutoff) delete bot.recentlyCancelled[id];
      }
    }

    // Fill detection uses openOrders (weight 20 on Hyperliquid — expensive).
    // Only check every OTHER loop to halve the rate-limit cost. Order fills
    // still get caught within ~12s worst case, fine for grid trading.
    if (bot.loopCount % 2 === 0 || bot.openOrders.length === 0) {
      await checkAndHandleFills(botId, currentPrice);
    }

    if (bot.loopCount % 5 === 0) await syncOrdersFromExchange(botId);

    // Bail before maintainGrid if stop was clicked during this iteration
    if (!bot.running) return;
    await maintainGrid(botId, currentPrice);

    // Telegram RT alert — fires once per actual completed round trip.
    const cfg2 = bot.config;
    const completedCount = bot.completedRoundTrips.length;
    if (completedCount > (bot.lastNotifiedRt || 0) && cfg2?.telegramToken && cfg2?.telegramChatId) {
      const newlyCompleted = completedCount - (bot.lastNotifiedRt || 0);
      const totalGross = bot.completedRoundTrips.reduce((s, r) => s + (r.grossPnl ?? r.pnl ?? 0), 0);
      const totalFees  = bot.completedRoundTrips.reduce((s, r) => s + (r.totalFee || 0), 0);
      const totalNet   = totalGross - totalFees;
      const tag        = EXCHANGE_TAG[exchangeKey];
      const runtimeStr = bot.startedAt ? formatDuration(Date.now() - bot.startedAt) : "—";
      const netSign    = totalNet >= 0 ? "+" : "";
      await sendTelegram(cfg2.telegramToken, cfg2.telegramChatId,
        `${tag} 📊 RT #${completedCount}\n` +
        `Runtime: ${runtimeStr}\n` +
        `Gross:   +$${totalGross.toFixed(4)}\n` +
        `Fees:    -$${totalFees.toFixed(4)}\n` +
        `<b>Net:    ${netSign}$${totalNet.toFixed(4)}</b>` +
        (newlyCompleted > 1 ? `\n(${newlyCompleted} new since last update)` : "")
      );
      bot.lastNotifiedRt = completedCount;
      log(botId, `📲 Telegram summary  RTs: ${completedCount}  Net: ${netSign}$${totalNet.toFixed(4)}  Runtime: ${runtimeStr}`);
    }

    broadcast("state", buildStateSnapshot());

    // Persist in-memory state every 10s so a deploy/reboot can resume in
    // place without cancelling orders or recomputing the grid.
    if (!bot._lastStateSave || Date.now() - bot._lastStateSave > 10000) {
      bot._lastStateSave = Date.now();
      db.saveSessionState(botId, {
        openOrders         : bot.openOrders,
        pendingRoundTrips  : bot.pendingRoundTrips,
        completedRoundTrips: bot.completedRoundTrips.slice(0, 200),
        fillHistory        : bot.fillHistory.slice(0, 500),
        gridAnchor         : bot.gridAnchor,
        entryPrice         : bot.entryPrice,
        upperLimit         : bot.upperLimit,
        lowerLimit         : bot.lowerLimit,
        lastPrice          : bot.lastPrice,
        lastNotifiedRt     : bot.lastNotifiedRt,
        startedAt          : bot.startedAt,
        savedAt            : new Date().toISOString(),
      });
    }
  } catch (err) {
    if ((err.message || "").includes("429") || /too many requests/i.test(err.message || "")) {
      bot.rateLimitUntil = Date.now() + 45000;  // pause 45s on rate limit
      log(botId, `⏸ Rate limited (429) — pausing this bot for 45s. Consider fewer bots or slower loop.`, "warn");
    } else {
      log(botId, `Loop error: ${err.message}`, "error");
    }
  } finally {
    // Critical: always release the loop lock so the NEXT tick can run.
    // Without this, an exception would leave _loopBusy=true forever and
    // the bot would silently stop processing.
    bot._loopBusy = false;
    bot._missedLoops = 0;
  }
}

// ============================================================
//  CHECK FILLS
// ============================================================
async function checkAndHandleFills(botId, currentPrice) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  const cfg = bot.config;
  if (bot.openOrders.length === 0) return;

  // ── HYPERLIQUID FAST PATH ───────────────────────────────────────────
  // CCXT's fetchOrder is broken on Hyperliquid (issue #27113). It returns
  // wrong/stale data, leading to phantom duplicate fills. Use native
  // openOrders to determine fills:
  //   - fetch user's open orders ONCE
  //   - any tracked order NOT in that list = filled
  // Each filled order is processed exactly once (idempotent).
  if (exchangeKey === "hyperliquid") {
    const cache = bot.hlCache;
    if (!cache?.infoClient) {
      // No cache yet — skip this cycle, will retry next loop
      return;
    }
    const wallet = process.env.HYPERLIQUID_WALLET_ADDRESS;
    let exchangeOrders;
    try {
      exchangeOrders = await Promise.race([
        cache.infoClient.openOrders({ user: wallet }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("openOrders timeout 5s")), 5000)),
      ]);
    } catch (err) {
      log(botId, `Native openOrders failed: ${err.message} — skipping fill check`, "warn");
      return;
    }

    // exchangeOrders is array of { coin, oid, side, sz, limitPx, ... }
    // Build a set of oid strings still open on the exchange
    const stillOpenIds = new Set(exchangeOrders.map(o => String(o.oid)));

    // Filter to orders for THIS market. Perp coin = "HYPE", spot coin = "@107"
    // (or a named pair). Match on cache.coinId. If NONE match the coinId but
    // there ARE open orders, the coin format is unexpected — fall back to
    // matching purely by oid (our locally-tracked IDs are unique anyway).
    const ourCoinId = cache.coinId;
    let ourOpen = exchangeOrders.filter(o => o.coin === ourCoinId);
    if (ourOpen.length === 0 && exchangeOrders.length > 0) {
      // Fallback: trust oid matching across all returned orders
      ourOpen = exchangeOrders;
    }
    const ourOpenIds = new Set(ourOpen.map(o => String(o.oid)));

    const stillOpenLocal = [];
    for (const tracked of bot.openOrders) {
      const trackedId = String(tracked.id);
      // Skip if we just placed it (within last 3 sec) — exchange might not have indexed yet
      const age = Date.now() - (tracked.placedAt || 0);
      if (age < 3000) {
        stillOpenLocal.push(tracked);
        continue;
      }

      if (ourOpenIds.has(trackedId)) {
        // Still alive on exchange
        stillOpenLocal.push(tracked);
        continue;
      }

      // Tracked order is GONE from exchange — must be filled (or externally cancelled).
      // If it was in recentlyCancelled, treat as cancel and just drop it.
      if (bot.recentlyCancelled?.[trackedId]) {
        delete bot.recentlyCancelled[trackedId];
        continue;
      }

      // Treat as FILLED.
      const fillTs    = new Date().toISOString();
      const fillPrice = tracked.price;
      const fillQty   = tracked.qty;
      // Estimate maker fee for this fill (post-only ensures maker rate)
      const feeEst    = estimateFee(cfg.priceSource, fillPrice, fillQty);
      log(botId, `FILLED [${tracked.type.toUpperCase()}] ${tracked.side.toUpperCase()} @ $${fillPrice}  qty:${fillQty}  fee≈$${feeEst.toFixed(4)}`, "success");

      const hlFill = {
        side: tracked.side, price: fillPrice, qty: fillQty,
        type: tracked.type, ts: fillTs,
        fee: feeEst, feeCcy: "USDC", orderId: tracked.id,
      };
      bot.fillHistory.unshift(hlFill);
      db.recordFill(bot, hlFill);

      if (tracked.type === "entry") {
        const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol);
        const targetSide  = tracked.side === "sell" ? "buy" : "sell";
        const targetPrice = tracked.side === "sell"
          ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
          : roundPrice(fillPrice + cfg.targetSpread, tickSize);

        bot.pendingRoundTrips.push({
          id: `rt_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
          openSide: tracked.side, openPrice: fillPrice,
          targetOrderId: null, targetSide, targetPrice,
          qty: fillQty, openTs: fillTs,
        });
        log(botId, `📌 Pending RT: ${tracked.side.toUpperCase()} @ $${fillPrice} → target ${targetSide.toUpperCase()} @ $${targetPrice} (${bot.pendingRoundTrips.length} pending)`);

      } else if (tracked.type === "target") {
        const matched = bot.pendingRoundTrips.filter(rt => rt.targetOrderId === tracked.id);
        if (matched.length === 0) {
          // Fallback: price-based
          const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol);
          const entrySide  = tracked.side === "buy" ? "sell" : "buy";
          const entryPrice = tracked.side === "buy"
            ? roundPrice(fillPrice + cfg.targetSpread, tickSize)
            : roundPrice(fillPrice - cfg.targetSpread, tickSize);
          const fallbackIdx = bot.pendingRoundTrips.findIndex(
            rt => rt.openSide === entrySide && Math.abs(rt.openPrice - entryPrice) < tickSize
          );
          if (fallbackIdx !== -1) {
            matched.push(bot.pendingRoundTrips[fallbackIdx]);
            log(botId, `Target matched by price fallback`, "warn");
          }
        }
        bot.pendingRoundTrips = bot.pendingRoundTrips.filter(rt => !matched.includes(rt));
        for (const rt of matched) {
          const buyPrice  = rt.openSide === "buy"  ? rt.openPrice : fillPrice;
          const sellPrice = rt.openSide === "sell" ? rt.openPrice : fillPrice;
          const grossPnl  = parseFloat(((sellPrice - buyPrice) * rt.qty).toFixed(8));
          // Estimate fees for BOTH fills of this round trip (entry + close).
          // Post-only is enforced, so both are maker rate.
          const openFee   = estimateFee(cfg.priceSource, rt.openPrice, rt.qty);
          const closeFee  = estimateFee(cfg.priceSource, fillPrice,     rt.qty);
          const totalFee  = parseFloat((openFee + closeFee).toFixed(8));
          const netPnl    = parseFloat((grossPnl - totalFee).toFixed(8));
          const hlRt = {
            id: rt.id, openSide: rt.openSide,
            openPrice: rt.openPrice, closePrice: fillPrice,
            buyPrice, sellPrice, qty: rt.qty,
            pnl: grossPnl,           // gross (kept for backward compat)
            grossPnl, totalFee, netPnl,
            openTs: rt.openTs, closeTs: fillTs,
            durationMs: Date.now() - new Date(rt.openTs).getTime(),
          };
          bot.completedRoundTrips.unshift(hlRt);
          db.recordRoundTrip(bot, hlRt, bot.completedRoundTrips.length);
          const netSign = netPnl >= 0 ? "+" : "";
          log(botId, `✅ ROUND TRIP #${bot.completedRoundTrips.length}  Buy@$${buyPrice.toFixed(4)} → Sell@$${sellPrice.toFixed(4)}  qty:${rt.qty}  Gross:+$${grossPnl.toFixed(4)}  Fee:-$${totalFee.toFixed(4)}  Net:${netSign}$${netPnl.toFixed(4)}`, "success");
          if (cfg?.telegramToken && cfg?.telegramChatId) {
            const tag = EXCHANGE_TAG[exchangeKey];
            sendTelegram(cfg.telegramToken, cfg.telegramChatId,
              `${tag} ✅ Round Trip #${bot.completedRoundTrips.length}\nSymbol: ${cfg.symbol}\nBuy: $${buyPrice.toFixed(4)}\nSell: $${sellPrice.toFixed(4)}\nQty: ${rt.qty}\nGross: +$${grossPnl.toFixed(4)}\nFees:  -$${totalFee.toFixed(4)}\nNet:   ${netSign}$${netPnl.toFixed(4)}`
            );
          }
        }
      }
    }
    bot.openOrders = stillOpenLocal;
    return;
  }

  // ── DEFAULT PATH (Binance, Deribit): use CCXT fetchOrder per tracked ──
  const stillOpen = [];

  for (const tracked of bot.openOrders) {
    try {
      const order = await bot.exchange.fetchOrder(tracked.id, cfg.symbol);

      if (order.status === "closed" || order.status === "filled") {
        const fillTs    = new Date().toISOString();
        const fillPrice = parseFloat(order.average || order.price || tracked.price);
        const fillQty   = parseFloat(order.filled  || order.amount || tracked.qty);
        const feeCost   = parseFloat(order.fee?.cost ?? 0);
        const feeCcy    = order.fee?.currency || "";

        log(botId, `FILLED [${tracked.type.toUpperCase()}] ${tracked.side.toUpperCase()} @ $${fillPrice}  qty:${fillQty}`, "success");

        const ccxtFill = {
          side: tracked.side, price: fillPrice, qty: fillQty,
          type: tracked.type, ts: fillTs,
          fee: feeCost, feeCcy, orderId: tracked.id,
        };
        bot.fillHistory.unshift(ccxtFill);
        db.recordFill(bot, ccxtFill);

        if (tracked.type === "entry") {
          // Just record the pending round trip. The strict-6 algorithm in
          // maintainGrid (which runs immediately after this in gridLoop)
          // will handle target placement and entry promotion.
          const targetSide  = tracked.side === "sell" ? "buy" : "sell";
          const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol);
          const targetPrice = tracked.side === "sell"
            ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
            : roundPrice(fillPrice + cfg.targetSpread, tickSize);

          bot.pendingRoundTrips.push({
            id              : `rt_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
            openSide        : tracked.side,
            openPrice       : fillPrice,
            targetOrderId   : null,
            targetSide,
            targetPrice,
            qty             : fillQty,
            openTs          : fillTs,
          });
          log(botId, `📌 Pending RT: ${tracked.side.toUpperCase()} @ $${fillPrice} → target ${targetSide.toUpperCase()} @ $${targetPrice} (${bot.pendingRoundTrips.length} pending)`);

        } else if (tracked.type === "target") {
          // Find ALL pending RTs that point to this order id
          const matched = bot.pendingRoundTrips.filter(rt => rt.targetOrderId === tracked.id);

          if (matched.length === 0) {
            // Fallback: try price-based match for legacy/external orders
            const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol);
            const entrySide  = tracked.side === "buy" ? "sell" : "buy";
            const entryPrice = tracked.side === "buy"
              ? roundPrice(fillPrice + cfg.targetSpread, tickSize)
              : roundPrice(fillPrice - cfg.targetSpread, tickSize);
            const fallbackIdx = bot.pendingRoundTrips.findIndex(
              rt => rt.openSide === entrySide && Math.abs(rt.openPrice - entryPrice) < tickSize
            );
            if (fallbackIdx !== -1) {
              matched.push(bot.pendingRoundTrips[fallbackIdx]);
              log(botId, `Target matched by price fallback`, "warn");
            } else {
              log(botId, `Target filled but no pending RT linked — fill recorded as standalone`, "warn");
            }
          }

          // Remove matched RTs from pending and add to completed
          bot.pendingRoundTrips = bot.pendingRoundTrips.filter(rt => !matched.includes(rt));

          for (const rt of matched) {
            const buyPrice  = rt.openSide === "buy"  ? rt.openPrice : fillPrice;
            const sellPrice = rt.openSide === "sell" ? rt.openPrice : fillPrice;
            const grossPnl  = parseFloat(((sellPrice - buyPrice) * rt.qty).toFixed(8));
            // Prefer real fee from THIS close fill (we have it from order data);
            // estimate fee for the OPEN fill (it was recorded earlier).
            const openFee   = estimateFee(cfg.priceSource, rt.openPrice, rt.qty);
            const closeFee  = feeCost > 0 ? feeCost : estimateFee(cfg.priceSource, fillPrice, rt.qty);
            const totalFee  = parseFloat((openFee + closeFee).toFixed(8));
            const netPnl    = parseFloat((grossPnl - totalFee).toFixed(8));

            const ccxtRt = {
              id: rt.id, openSide: rt.openSide,
              openPrice: rt.openPrice, closePrice: fillPrice,
              buyPrice, sellPrice,
              qty: rt.qty,
              pnl: grossPnl,         // gross (kept for backward compat)
              grossPnl, totalFee, netPnl,
              openTs: rt.openTs, closeTs: fillTs,
              durationMs: Date.now() - new Date(rt.openTs).getTime(),
            };
            bot.completedRoundTrips.unshift(ccxtRt);
            db.recordRoundTrip(bot, ccxtRt, bot.completedRoundTrips.length);
            const netSign = netPnl >= 0 ? "+" : "";
            log(botId, `✅ ROUND TRIP #${bot.completedRoundTrips.length}  Buy@$${buyPrice.toFixed(4)} → Sell@$${sellPrice.toFixed(4)}  qty:${rt.qty}  Gross:+$${grossPnl.toFixed(4)}  Fee:-$${totalFee.toFixed(4)}  Net:${netSign}$${netPnl.toFixed(4)}`, "success");

            if (cfg?.telegramToken && cfg?.telegramChatId) {
              const tag = EXCHANGE_TAG[exchangeKey];
              sendTelegram(cfg.telegramToken, cfg.telegramChatId,
                `${tag} ✅ Round Trip #${bot.completedRoundTrips.length}\nSymbol: ${cfg.symbol}\nBuy: $${buyPrice.toFixed(4)}\nSell: $${sellPrice.toFixed(4)}\nQty: ${rt.qty}\nGross: +$${grossPnl.toFixed(4)}\nFees:  -$${totalFee.toFixed(4)}\nNet:   ${netSign}$${netPnl.toFixed(4)}`
              );
            }
          }
        }

      } else if (order.status === "open" || order.status === "partially_filled") {
        stillOpen.push(tracked);
      }
    } catch (err) {
      log(botId, `fetchOrder error (${tracked.id}): ${err.message}`, "warn");
      stillOpen.push(tracked);
    }
  }

  bot.openOrders = stillOpen;
}

// ============================================================
//  PLACE TARGET ORDER
//  Returns { id, price, qty, side } of the placed (or existing) target
//  order, OR null if placement completely failed. The returned id is
//  used to link the round trip to the order, so closing matches by
//  order id (not by price reconstruction, which fails when prices
//  drift due to post_only safe-price adjustments).
// ============================================================
async function placeTargetOrder(botId, filledSide, fillPrice, fillQty) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  const cfg = bot.config;
  const { tickSize, stepSize } = await getMarketInfo(bot.exchange, cfg.symbol);

  const targetSide  = filledSide === "sell" ? "buy" : "sell";
  const targetPrice = filledSide === "sell"
    ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
    : roundPrice(fillPrice + cfg.targetSpread, tickSize);
  const qty = roundQty(fillQty, stepSize);

  // ── Smart sharing/promotion at the target price ──
  // If an order already exists on the same side at the exact target price,
  // we have two cases:
  //   (a) An existing TARGET → share it (multi-entry → one target close-out)
  //   (b) An existing ENTRY at that price → PROMOTE it to a target. The
  //       order on the exchange doesn't change (same side, same price), so
  //       we just relabel it locally. This avoids placing a duplicate.
  const existing = bot.openOrders.find(o => o.side === targetSide && Math.abs(o.price - targetPrice) < 0.000001);
  if (existing) {
    if (existing.type === "entry") {
      existing.type = "target";   // promote in-place
      log(botId, `Promoted ENTRY ${targetSide.toUpperCase()} @ $${targetPrice} → TARGET (same side & price as needed target)`, "success");
    } else {
      log(botId, `Target ${targetSide.toUpperCase()} @ $${targetPrice} already on exchange — sharing with existing target`);
    }
    return { id: existing.id, price: existing.price, qty: existing.qty, side: targetSide, shared: true };
  }

  const sideOrders = bot.openOrders.filter(o => o.side === targetSide);
  if (sideOrders.length >= 3) {
    const victim = sideOrders.filter(o => o.type === "entry")
      .sort((a,b) => Math.abs(b.price - fillPrice) - Math.abs(a.price - fillPrice))[0];
    if (victim) {
      const ok = await cancelSingleOrder(botId, victim.id, cfg.symbol);
      if (ok) {
        bot.recentlyCancelled = bot.recentlyCancelled || {};
        bot.recentlyCancelled[victim.id] = Date.now();
        bot.openOrders = bot.openOrders.filter(o => o.id !== victim.id);
        log(botId, `Removed ENTRY ${victim.side.toUpperCase()} @ $${victim.price} — making room for target`);
      } else {
        log(botId, `Could not remove entry ${victim.id} — will retry`, "warn");
      }
    }
  }

  // Post-only on all exchanges for maker fees:
  //   Hyperliquid: placeSingleOrder routes through hyperliquidNativeOrders (Alo)
  //   Binance: timeInForce GTX (spot) / postOnly (futures)
  //   Deribit: post_only
  let params = {};
  if (exchangeKey === "deribit") params = { post_only: true };
  else if (exchangeKey === "binance") params = { timeInForce: "GTX", postOnly: true };

  try {
    let orderId;
    if (exchangeKey === "hyperliquid") {
      const r = await placeSingleOrder(botId, targetSide, qty, targetPrice, cfg.symbol, {});
      orderId = r.id;
    } else {
      const order = await bot.exchange.createLimitOrder(cfg.symbol, targetSide, qty, targetPrice, params);
      orderId = order.id;
    }
    bot.openOrders.push({ id: orderId, side: targetSide, price: targetPrice, qty, type: "target", placedAt: Date.now() });
    log(botId, `Target ${targetSide.toUpperCase()} placed @ $${targetPrice}`);
    return { id: orderId, price: targetPrice, qty, side: targetSide, shared: false };
  } catch (err) {
    const isPostOnlyReject = (err.message || "").includes("post_only_reject");
    if (exchangeKey === "deribit" && isPostOnlyReject) {
      // Spread crossed — retry one tick further from market
      const ticker = await getTickerSnapshot(bot.exchange, cfg.symbol).catch(() => null);
      const ask = ticker?.ask || bot.bestAsk || targetPrice;
      const bid = ticker?.bid || bot.bestBid || targetPrice;
      const safePrice = targetSide === "sell"
        ? roundPrice(Math.max(targetPrice, ask + tickSize), tickSize)
        : roundPrice(Math.min(targetPrice, bid - tickSize), tickSize);
      log(botId, `Target ${targetSide.toUpperCase()} @ $${targetPrice} crossed spread, retrying @ $${safePrice}`, "warn");
      try {
        const order = await bot.exchange.createLimitOrder(cfg.symbol, targetSide, qty, safePrice, params);
        bot.openOrders.push({ id: order.id, side: targetSide, price: safePrice, qty, type: "target", placedAt: Date.now() });
        log(botId, `Target ${targetSide.toUpperCase()} placed @ $${safePrice} (adjusted)`);
        return { id: order.id, price: safePrice, qty, side: targetSide, shared: false };
      } catch (retryErr) {
        log(botId, `Target retry failed @ $${safePrice}: ${retryErr.message}`, "error");
        return null;
      }
    }
    log(botId, `Target placement failed @ $${targetPrice}: ${err.message}`, "error");
    return null;
  }
}

// ============================================================
//  MAINTAIN GRID
// ============================================================
// ============================================================
//  MAINTAIN GRID  (always exactly 6 orders, by proximity priority)
//  Algorithm:
//    1. Collect "wanted" orders:
//       - Pending targets (one per pending RT)
//       - Up to 3 entry sells above current price (stepping outward)
//       - Up to 3 entry buys  below current price
//    2. Dedupe by (side, price), preferring targets over entries
//    3. Sort by distance from current price
//    4. Take top TARGET_TOTAL = 6
//    5. Diff against bot.openOrders (match by side+price):
//       - Cancel any open order NOT in the desired set
//       - Place any desired order NOT already on the exchange
// ============================================================
async function maintainGrid(botId, currentPrice) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  if (!bot.running) return;
  const cfg = bot.config;
  const { tickSize, stepSize } = await getMarketInfo(bot.exchange, cfg.symbol);
  const qty = roundQty(cfg.qtyPerStep, stepSize);
  const PER_SIDE = 3;            // exactly 3 above + 3 below = 6 total
  const isDeribit = exchangeKey === "deribit";
  // Post-only for ALL exchanges — guarantees maker fee, never accidental taker.
  //   Binance spot: timeInForce 'GTX' (Good Till Crossing = post-only)
  //   Binance futures: postOnly: true
  //   Deribit: post_only: true
  //   Hyperliquid: handled separately (Alo tif in hyperliquidNativeOrders)
  let orderParams = {};
  if (isDeribit) {
    orderParams = { post_only: true };
  } else if (exchangeKey === "binance") {
    // Spot uses 'GTX'; futures use postOnly. CCXT accepts both; pass both for safety.
    orderParams = { timeInForce: "GTX", postOnly: true };
  }

  const bid = bot.bestBid || currentPrice;
  const ask = bot.bestAsk || currentPrice;
  // Use bid/ask floors for ALL exchanges now (post-only would reject otherwise):
  //   A SELL must be at or above the best ASK (otherwise it'd cross → taker → reject)
  //   A BUY  must be at or below the best BID
  const minSellPrice = roundPrice(ask + tickSize, tickSize);
  const maxBuyPrice  = roundPrice(bid - tickSize, tickSize);
  const isPostOnlyReject = (err) => {
    const m = (err?.message || "").toLowerCase();
    return m.includes("post_only_reject") || m.includes("post-only") ||
           m.includes("would immediately match") || m.includes("rejected post-only");
  };

  // ════════════════════════════════════════════════════════════════════
  //  PER-SIDE STRICT 3+3
  //  ABOVE price = SELL side (entries + targets that sit above price)
  //  BELOW price = BUY side  (entries + targets that sit below price)
  //  Each side independently keeps its 3 CLOSEST-to-price orders.
  //  Targets are preferred over entries when both want the same slot.
  // ════════════════════════════════════════════════════════════════════

  // ---- 1. Reserved entry prices (an open RT's entry slot is locked) ----
  const reservedEntryPrices = new Set();
  for (const rt of bot.pendingRoundTrips) {
    reservedEntryPrices.add(`${rt.openSide}_${roundPrice(rt.openPrice, tickSize)}`);
  }

  // ---- 2. Build WANTED for each side separately ----
  const wantSell = [];   // each: {side, price, qty, type, rtId, distance}
  const wantBuy  = [];

  // ACTIVE BAND: a target is only "active" (placed as a resting order) if it
  // sits within this distance of current price. The band spans the 3 grid
  // steps the bot keeps on each side. A target further out than this is
  // "parked": its order is cancelled and a fresh ENTRY takes the slot near
  // price (keeps the grid tight). The round trip is NOT lost — when price
  // moves back so the target re-enters the band, it is re-placed and the
  // RT closes at full profit. This is the hybrid you asked for.
  const bandSpacingSell = cfg.avgSellSpacing;
  const bandSpacingBuy  = cfg.avgBuySpacing;
  // HYSTERESIS to stop boundary flicker:
  //  - parkBand: distance beyond which an ACTIVE target gets parked
  //  - keepBand: a parked target only RE-activates when it comes back inside
  //    this tighter band. parkBand > keepBand creates a dead-zone so a target
  //    sitting right at the edge doesn't park/unpark every loop.
  const sellParkBand = (PER_SIDE + 1.5) * bandSpacingSell;
  const sellKeepBand = (PER_SIDE + 0.5) * bandSpacingSell;
  const buyParkBand  = (PER_SIDE + 1.5) * bandSpacingBuy;
  const buyKeepBand  = (PER_SIDE + 0.5) * bandSpacingBuy;

  let parkedCount = 0;

  // 2a. Targets — route by ORDER SIDE. Use the RT's REAL target price (never
  //     a currentPrice-derived value, which would change every loop and cause
  //     endless cancel/replace churn). A target on the "wrong" side of price
  //     just means price moved past it → it will fill as a taker, which is
  //     correct (you wanted to sell at X, price is now above X → sell).
  for (const rt of bot.pendingRoundTrips) {
    const p = roundPrice(rt.targetPrice, tickSize);
    const dist = Math.abs(p - currentPrice);
    const wasParked = !!rt.parked;

    if (rt.targetSide === "buy") {
      if (isDeribit && p > maxBuyPrice) { rt.parked = true; parkedCount++; continue; }
      // Use keepBand if currently active, parkBand if currently parked → hysteresis
      const threshold = wasParked ? buyKeepBand : buyParkBand;
      if (dist <= threshold) {
        rt.parked = false;
        wantBuy.push({ side: "buy", price: p, qty: rt.qty,
                       type: "target", rtId: rt.id, distance: dist });
      } else {
        rt.parked = true; parkedCount++;
      }
    } else {
      if (isDeribit && p < minSellPrice) { rt.parked = true; parkedCount++; continue; }
      const threshold = wasParked ? sellKeepBand : sellParkBand;
      if (dist <= threshold) {
        rt.parked = false;
        wantSell.push({ side: "sell", price: p, qty: rt.qty,
                        type: "target", rtId: rt.id, distance: dist });
      } else {
        rt.parked = true; parkedCount++;
      }
    }
  }
  if (parkedCount > 0) {
    log(botId, `${parkedCount} target(s) parked (too far from price) — entries fill the grid; targets auto-return when price comes back`, "info");
  }

  // 2b. Entry candidates — SIMPLE SPACING from a stable anchor.
  //   The anchor only moves when price leaves the WHOLE grid band (i.e.
  //   price has moved past the innermost order on one side). Within the
  //   band, the grid is completely fixed — no order is recalculated, so
  //   nothing churns. Entry validity is judged against the ANCHOR, never
  //   the live price, so a small wiggle can't flip an order in/out.
  const sSpace = cfg.avgSellSpacing;
  const bSpace = cfg.avgBuySpacing;
  // Re-anchor only when price has moved beyond ~1 full step past the anchor
  // on either side (i.e. it would have crossed the innermost entry). This
  // is the band half-width. Use the SMALLER side spacing for symmetry.
  const reanchorTol = Math.min(sSpace, bSpace) * 1.0;

  if (bot.gridAnchor == null ||
      currentPrice > bot.gridAnchor + reanchorTol ||
      currentPrice < bot.gridAnchor - reanchorTol) {
    // Snap to the spacing grid so the anchor is a STABLE, repeatable level.
    // Two nearby prices that round to the same grid level produce the SAME
    // anchor → zero order changes. Re-anchor only logs when it truly moves.
    const gridStep = Math.min(sSpace, bSpace);
    const snapped  = roundPrice(Math.round(currentPrice / gridStep) * gridStep, tickSize);
    if (snapped !== bot.gridAnchor) {
      bot.gridAnchor = snapped;
      log(botId, `Grid re-anchored to $${bot.gridAnchor} (price $${currentPrice})`, "info");
    }
  }
  const anchor = bot.gridAnchor;

  // Generate entries purely from the anchor (NOT compared to currentPrice,
  // which moves and would cause flicker). Bounds checks use the static
  // upper/lower limits and the exchange post-only floors only.
  for (let i = 1; i <= PER_SIDE + 3; i++) {
    const ps = roundPrice(anchor + i * sSpace, tickSize);
    if (ps >= minSellPrice && ps <= bot.upperLimit
        && !reservedEntryPrices.has(`sell_${ps}`)) {
      wantSell.push({ side: "sell", price: ps, qty, type: "entry", rtId: null,
                      distance: Math.abs(ps - currentPrice) });
    }
    const pb = roundPrice(anchor - i * bSpace, tickSize);
    if (pb <= maxBuyPrice && pb >= bot.lowerLimit
        && !reservedEntryPrices.has(`buy_${pb}`)) {
      wantBuy.push({ side: "buy", price: pb, qty, type: "entry", rtId: null,
                     distance: Math.abs(pb - currentPrice) });
    }
  }

  // ---- 3. Dedupe per side by price; prefer target over entry ----
  //   CRITICAL: sort by PRICE, not distance-to-currentPrice. Distance sort
  //   makes the chosen 3 flip every time price wiggles across a midpoint
  //   → endless cancel/replace churn. Price sort is stable: the SELL side
  //   is always the 3 LOWEST sells (nearest above), the BUY side the 3
  //   HIGHEST buys (nearest below). These don't change as price moves
  //   within the grid, so orders stay put.
  const dedupeSide = (arr, ascending) => {
    const m = new Map();
    for (const w of arr) {
      const k = w.price;
      const prev = m.get(k);
      if (!prev) { m.set(k, w); continue; }
      if (prev.type === "target" && w.type === "entry") continue;
      if (prev.type === "entry"  && w.type === "target") m.set(k, w);
    }
    const list = [...m.values()];
    list.sort((a, b) => ascending ? a.price - b.price : b.price - a.price);
    return list;
  };
  const sellDesired = dedupeSide(wantSell, true ).slice(0, PER_SIDE);  // 3 lowest sells
  const buyDesired  = dedupeSide(wantBuy,  false).slice(0, PER_SIDE);  // 3 highest buys
  const desired = [...sellDesired, ...buyDesired];

  // ---- 4. Diff against current open orders ----
  const desiredKeys = new Set(desired.map(d => `${d.side}_${d.price}`));
  const existingByKey = new Map();
  for (const o of bot.openOrders) existingByKey.set(`${o.side}_${o.price}`, o);

  // 4a. Cancel any open order NOT in desired (these are the "far" ones)
  const toCancel = bot.openOrders.filter(o => !desiredKeys.has(`${o.side}_${o.price}`));
  if (toCancel.length > 0) {
    if (exchangeKey === "hyperliquid") {
      // ONE batched native call cancels all far orders at once (~0.5s total
      // instead of N×0.5s serial). Removes the placement delay you saw.
      const ids = toCancel.map(o => o.id);
      const result = await hyperliquidNativeCancel(bot, ids);
      if (result.ok) {
        for (const r of result.results) {
          const o = toCancel.find(x => Number(x.id) === r.id);
          if (!o) continue;
          const s = r.status;
          const gone = (s === "success") || (s && s.error && /never placed|already cancel|filled/i.test(s.error));
          if (gone) {
            bot.recentlyCancelled = bot.recentlyCancelled || {};
            bot.recentlyCancelled[o.id] = Date.now();
            bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
            if (o.type === "target") {
              for (const rt of bot.pendingRoundTrips) {
                if (rt.targetOrderId === o.id) rt.targetOrderId = null;
              }
            }
            log(botId, `↓ Cancelled ${o.type?.toUpperCase()||""} ${o.side.toUpperCase()} @ $${o.price} — far from price`);
          }
        }
      } else {
        log(botId, `Batch cancel failed: ${result.error} — will retry next loop`, "warn");
      }
    } else {
      // CCXT path (Binance/Deribit): serial is fine, those APIs are fast
      for (const o of toCancel) {
        if (!bot.running) break;
        const ok = await cancelSingleOrder(botId, o.id, cfg.symbol);
        if (ok) {
          bot.recentlyCancelled = bot.recentlyCancelled || {};
          bot.recentlyCancelled[o.id] = Date.now();
          bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
          if (o.type === "target") {
            for (const rt of bot.pendingRoundTrips) {
              if (rt.targetOrderId === o.id) rt.targetOrderId = null;
            }
          }
          log(botId, `↓ Cancelled ${o.type?.toUpperCase()||""} ${o.side.toUpperCase()} @ $${o.price} — far from price`);
        } else {
          log(botId, `Cancel failed for ${o.id} — will retry next loop`, "warn");
        }
      }
    }
  }

  // 4b. Promote existing entry→target where a desired target matches it
  for (const d of desired) {
    const existing = existingByKey.get(`${d.side}_${d.price}`);
    if (!existing) continue;
    if (d.type === "target" && existing.type !== "target") {
      existing.type = "target";
      if (d.rtId) {
        const rt = bot.pendingRoundTrips.find(r => r.id === d.rtId);
        if (rt && !rt.targetOrderId) rt.targetOrderId = existing.id;
      }
      log(botId, `🔗 Promoted ${existing.side.toUpperCase()} @ $${existing.price} → TARGET`, "success");
    }
  }

  // 4c. Place desired orders not yet open
  const existingKeys = new Set(bot.openOrders.map(o => `${o.side}_${o.price}`));
  let toPlace = desired.filter(d => !existingKeys.has(`${d.side}_${d.price}`));

  // ── PER-SIDE COUNT CAP ──
  // If a cancel failed last loop, that side may already have PER_SIDE
  // open orders. Don't add MORE — wait for the failed cancel to clear
  // next loop. Without this, sides can grow to 4+ orders.
  {
    const sellOpen = bot.openOrders.filter(o => o.side === "sell").length;
    const buyOpen  = bot.openOrders.filter(o => o.side === "buy").length;
    const sellRoom = Math.max(0, PER_SIDE - sellOpen);
    const buyRoom  = Math.max(0, PER_SIDE - buyOpen);
    let placedSells = 0, placedBuys = 0;
    toPlace = toPlace.filter(d => {
      if (d.side === "sell" && placedSells < sellRoom) { placedSells++; return true; }
      if (d.side === "buy"  && placedBuys  < buyRoom ) { placedBuys++;  return true; }
      return false;
    });
  }

  // ── SPOT INVENTORY GATE ────────────────────────────────────────────
  // On Hyperliquid SPOT you can only sell base token you actually hold.
  // Check free HYPE balance and cap the number of sell orders we place
  // (entries + targets) so we don't spam "insufficient balance" failures.
  if (exchangeKey === "hyperliquid" && bot.hlCache?.isSpot) {
    const base = bot.hlCache.base;
    const freeBase = await hyperliquidNativeSpotBalance(bot, base);
    if (freeBase === null) {
      log(botId, `Spot balance unavailable — placing all; some sells may fail`, "warn");
    } else {
      const wantSellOrders = toPlace.filter(d => d.side === "sell");
      const buyOrders      = toPlace.filter(d => d.side === "buy");
      let budget = freeBase;
      const allowedSells = [];
      for (const d of wantSellOrders.sort((a,b)=>a.distance-b.distance)) {
        if (budget >= d.qty - 1e-9) { allowedSells.push(d); budget -= d.qty; }
      }
      if (allowedSells.length < wantSellOrders.length) {
        log(botId, `Spot inventory: ${freeBase.toFixed(4)} ${base} free → can place ${allowedSells.length}/${wantSellOrders.length} sells`, "warn");
      }
      toPlace = [...buyOrders, ...allowedSells];
    }
  }

  if (exchangeKey === "hyperliquid" && toPlace.length > 0) {
    const reqs = toPlace.map(d => ({ side: d.side, price: d.price, qty: d.qty }));
    const results = await hyperliquidNativeOrders(bot, reqs);
    for (let i = 0; i < toPlace.length; i++) {
      if (!bot.running) break;
      const d = toPlace[i], r = results[i];
      if (r.id) {
        bot.openOrders.push({ id: r.id, side: d.side, price: d.price, qty: d.qty,
                              type: d.type, placedAt: Date.now() });
        if (d.type === "target" && d.rtId) {
          const rt = bot.pendingRoundTrips.find(rr => rr.id === d.rtId);
          if (rt) rt.targetOrderId = r.id;
        }
        const tag = d.type === "target" ? "🎯 TARGET" : "📥 ENTRY";
        log(botId, `↑ ${tag} ${d.side.toUpperCase()} @ $${d.price}  qty:${d.qty} [post-only Alo]${r.filled ? "  ⚠ FILLED IMMEDIATELY (rare)" : ""}`);
      } else {
        const msg = r.error || "unknown";
        // Hyperliquid Alo reject => order would cross spread → would be taker.
        // This is EXPECTED — we want to skip taker fills. Retry next loop
        // when the spread has moved or the anchor shifts.
        const isAloReject = /post.?only|alo|would.*cross|cross.*book|reject/i.test(msg);
        if (isAloReject) {
          log(botId, `${d.side.toUpperCase()} @ $${d.price} would be TAKER — skipped (post-only). Retry next loop.`, "warn");
        } else {
          log(botId, `Place ${d.type.toUpperCase()} ${d.side.toUpperCase()} failed @ $${d.price}: ${msg}`, "error");
        }
      }
    }
  } else {
    for (const d of toPlace) {
      if (!bot.running) break;
      try {
        const order = await bot.exchange.createLimitOrder(cfg.symbol, d.side, d.qty, d.price, orderParams);
        bot.openOrders.push({ id: order.id, side: d.side, price: d.price, qty: d.qty,
                              type: d.type, placedAt: Date.now() });
        if (d.type === "target" && d.rtId) {
          const rt = bot.pendingRoundTrips.find(r => r.id === d.rtId);
          if (rt) rt.targetOrderId = order.id;
        }
        const tag = d.type === "target" ? "🎯 TARGET" : "📥 ENTRY";
        log(botId, `↑ ${tag} ${d.side.toUpperCase()} @ $${d.price}  qty:${d.qty}`);
      } catch (err) {
        if (isPostOnlyReject(err)) {
          log(botId, `${d.side.toUpperCase()} @ $${d.price} crossed spread — retry next loop`, "warn");
        } else {
          log(botId, `Place ${d.type.toUpperCase()} ${d.side.toUpperCase()} failed @ $${d.price}: ${err.message}`, "error");
        }
      }
    }
  }

  // ---- 5. Status summary ----
  const sellCount = bot.openOrders.filter(o => o.price > currentPrice).length;
  const buyCount  = bot.openOrders.filter(o => o.price < currentPrice).length;
  const tg = bot.openOrders.filter(o => o.type === "target").length;
  const en = bot.openOrders.filter(o => o.type === "entry").length;
  if (toCancel.length > 0 || toPlace.length > 0) {
    log(botId, `Grid: ${sellCount} above + ${buyCount} below = ${bot.openOrders.length} (${en} entries, ${tg} targets)`);
  }
}

// ============================================================
//  CANCEL ALL + SYNC
// ============================================================
// Hyperliquid native order placement. Use this instead of CCXT
// createLimitOrder which can take 20+ seconds on Hyperliquid.
// Accepts an array of orders: [{side: "buy"|"sell", price: number, qty: number}, ...]
// Returns: [{id: string, error?: string}, ...] in same order as input.
// Native Hyperliquid spot balance for a given token. Fast (~200ms) vs
// CCXT fetchBalance which hangs/times out. Returns free amount (number).
async function hyperliquidNativeSpotBalance(bot, token) {
  const cache = bot.hlCache;
  if (!cache?.infoClient) return null;
  const wallet = process.env.HYPERLIQUID_WALLET_ADDRESS;
  try {
    const state = await Promise.race([
      cache.infoClient.spotClearinghouseState({ user: wallet }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    const bal = (state?.balances || []).find(b => b.coin === token);
    if (!bal) return 0;
    const total = parseFloat(bal.total || 0);
    const hold  = parseFloat(bal.hold  || 0);  // amount locked in open orders
    return Math.max(0, total - hold);            // free = total - hold
  } catch (e) {
    return null;  // null = couldn't determine (caller decides what to do)
  }
}

async function hyperliquidNativeOrders(bot, orders) {
  const cache = bot.hlCache;
  if (!cache?.assetIndex === undefined || !cache.exchClient) {
    return orders.map(() => ({ id: null, error: "Hyperliquid cache not initialized" }));
  }

  // Format price: max 5 sig figs for perps, 8 for spot. Also max szDecimals decimals.
  const formatPrice = (p) => {
    const sig = cache.maxSig;
    let s = p.toPrecision(sig);
    // toPrecision may give scientific notation for very small/large. Avoid it for typical crypto.
    if (s.includes("e")) s = Number(p).toFixed(sig);
    // Strip trailing zeros after decimal
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  };
  const formatSize = (sz) => {
    let s = sz.toFixed(cache.szDecimals);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  };

  const orderRequests = orders.map(o => ({
    a: cache.assetIndex,
    b: o.side === "buy",
    p: formatPrice(o.price),
    s: formatSize(o.qty),
    r: false,
    // "Alo" = Add Liquidity Only (post-only). Exchange REJECTS if the order
    // would cross the spread, instead of executing as taker. Guarantees the
    // maker rebate / lower fee tier. Rejected orders are caught below and
    // logged; the next loop will re-price further from market.
    t: { limit: { tif: "Alo" } },
  }));

  try {
    const resp = await Promise.race([
      cache.exchClient.order({ orders: orderRequests, grouping: "na" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Native order timeout 10s")), 10000)),
    ]);
    const statuses = resp?.response?.data?.statuses || [];
    return orders.map((_, i) => {
      const s = statuses[i];
      if (s?.resting) return { id: String(s.resting.oid), error: null };
      if (s?.filled)  return { id: String(s.filled.oid),  error: null, filled: true };
      if (s?.error)   return { id: null, error: s.error };
      return { id: null, error: "unknown status" };
    });
  } catch (e) {
    // Parse partial-success from error.response (same pattern as cancel)
    const statuses = e?.response?.response?.data?.statuses;
    if (Array.isArray(statuses) && statuses.length === orders.length) {
      return orders.map((_, i) => {
        const s = statuses[i];
        if (s?.resting) return { id: String(s.resting.oid), error: null };
        if (s?.filled)  return { id: String(s.filled.oid),  error: null, filled: true };
        if (s?.error)   return { id: null, error: s.error };
        return { id: null, error: "unknown status" };
      });
    }
    return orders.map(() => ({ id: null, error: e.message }));
  }
}

// Single-order place wrapper: native for Hyperliquid, CCXT for others
async function placeSingleOrder(botId, side, qty, price, symbol, orderParams) {
  const bot = bots[botId];
  const exchangeKey = bot.exchangeKey;
  if (exchangeKey === "hyperliquid") {
    const results = await hyperliquidNativeOrders(bot, [{ side, price, qty }]);
    const r = results[0];
    if (r.id) return { id: r.id, status: r.filled ? "filled" : "open" };
    throw new Error(r.error || "Place failed");
  }
  // CCXT path
  return await bot.exchange.createLimitOrder(symbol, side, qty, price, orderParams || {});
}


// ============================================================
// CCXT's Hyperliquid `cancelOrder` and `fetchOpenOrders` are known buggy
// (issues #26655 and #27113). We use the @nktkas/hyperliquid SDK to talk
// to the native Hyperliquid REST API directly. This signs cancel
// actions with the API wallet's private key and POSTs to /exchange.

// Single-order cancel wrapper: uses native SDK for Hyperliquid (fast),
// CCXT for others. Returns true on success, false on real failure.
// Already-filled/cancelled orders count as success.
async function cancelSingleOrder(botId, orderId, symbol) {
  const bot = bots[botId];
  const exchangeKey = bot.exchangeKey;
  if (exchangeKey === "hyperliquid") {
    const result = await hyperliquidNativeCancel(bot, [orderId]);
    if (!result.ok) return false;
    const s = result.results[0]?.status;
    if (s === "success") return true;
    if (s && s.error) {
      const m = s.error.toLowerCase();
      return m.includes("never placed") || m.includes("already cancel") || m.includes("filled");
    }
    return false;
  }
  // CCXT path for Binance/Deribit, with timeout safety
  try {
    await Promise.race([
      bot.exchange.cancelOrder(orderId, symbol),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 5s")), 5000)),
    ]);
    return true;
  } catch (err) {
    const m = (err.message || "").toLowerCase();
    if (m.includes("never placed") || m.includes("already cancel") || m.includes("filled") || m.includes("not found")) return true;
    return false;
  }
}

async function hyperliquidNativeCancel(bot, orderIds) {
  const cfg = bot.config;

  // Use pre-warmed SDK + asset index from bot.hlCache (set on bot start).
  // Falls back to fresh lookup only if the cache is missing.
  let exchClient, infoClient, assetIndex;
  if (bot.hlCache?.assetIndex !== undefined && bot.hlCache.exchClient) {
    exchClient = bot.hlCache.exchClient;
    infoClient = bot.hlCache.infoClient;
    assetIndex = bot.hlCache.assetIndex;
  } else {
    // Fresh lookup (slow path)
    const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
    const wallet = privateKeyToAccount(process.env.HYPERLIQUID_PRIVATE_KEY);
    const transport = new hl.HttpTransport({ isTestnet: useTestnet });
    exchClient = new hl.ExchangeClient({ wallet, transport, isTestnet: useTestnet });
    infoClient = new hl.InfoClient({ transport });

    const isSpot = (cfg.priceSource === "hyperliquid_spot");
    const base   = cfg.symbol.split("/")[0];
    assetIndex = -1;
    try {
      if (isSpot) {
        const m = await infoClient.spotMeta();
        for (let i = 0; i < m.universe.length; i++) {
          const baseToken = m.tokens[m.universe[i].tokens[0]];
          if (baseToken?.name === base) { assetIndex = 10000 + m.universe[i].index; break; }
        }
      } else {
        const m = await infoClient.meta();
        for (let i = 0; i < m.universe.length; i++) {
          if (m.universe[i].name === base) { assetIndex = i; break; }
        }
      }
    } catch (e) {
      return { ok: false, error: `Could not resolve asset index: ${e.message}`, results: [] };
    }
    if (assetIndex < 0) return { ok: false, error: `Asset not found in Hyperliquid universe`, results: [] };
  }

  // Build cancels array. Order IDs must be numeric.
  const cancels = orderIds.map(id => ({ a: assetIndex, o: Number(id) })).filter(c => Number.isFinite(c.o));
  if (cancels.length === 0) return { ok: false, error: "No valid numeric order IDs", results: [] };

  try {
    const resp = await Promise.race([
      exchClient.cancel({ cancels }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Native cancel timeout 10s")), 10000)),
    ]);
    // Response shape: { status: "ok", response: { type: "cancel", data: { statuses: [...] } } }
    const statuses = resp?.response?.data?.statuses || [];
    return { ok: true, results: cancels.map((c, i) => ({ id: c.o, status: statuses[i] })) };
  } catch (e) {
    // The SDK throws ApiRequestError when ANY individual cancel in a batch
    // has an "error" status, even when the others succeeded. The raw API
    // response is preserved on err.response. Extract the per-order statuses
    // so we report partial success correctly. Already-filled/cancelled
    // orders count as success (goal: no open order at that ID — achieved).
    const statuses = e?.response?.response?.data?.statuses;
    if (Array.isArray(statuses) && statuses.length === cancels.length) {
      return { ok: true, results: cancels.map((c, i) => ({ id: c.o, status: statuses[i] })) };
    }
    return { ok: false, error: e.message, results: [] };
  }
}


async function cancelAllOrders(botId) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  const cfg = bot.config;
  if (!bot.exchange || !cfg) return;

  // Mark bot as stopped first — prevents maintainGrid from racing
  bot.running = false;

  const toCancel = [...bot.openOrders];
  log(botId, `Starting cancel: ${toCancel.length} locally-tracked order(s)`, "info");

  if (toCancel.length === 0) {
    log(botId, `Nothing to cancel — local tracking is empty`, "info");
    bot.pendingRoundTrips = [];
    return;
  }

  // ── HYPERLIQUID FAST PATH ──────────────────────────────────────────
  // CCXT's Hyperliquid cancelOrder times out. Use native SDK instead.
  if (exchangeKey === "hyperliquid") {
    log(botId, `Using native Hyperliquid SDK for cancellation (bypass CCXT)`, "info");
    const orderIds = toCancel.map(o => o.id);
    const result = await hyperliquidNativeCancel(bot, orderIds);
    if (!result.ok) {
      log(botId, `❌ Native cancel failed: ${result.error}`, "error");
      log(botId, `⚠️ Please check Hyperliquid web UI and cancel manually`, "error");
    } else {
      let ok = 0, fail = 0;
      for (const r of result.results) {
        const status = r.status;
        const tracked = toCancel.find(o => Number(o.id) === r.id);
        const tag = tracked ? `${tracked.side?.toUpperCase()} @ $${tracked.price}` : `id ${r.id}`;
        if (status === "success") {
          log(botId, `  ↳ Cancelled ${tag}`, "info");
          ok++;
        } else if (status && status.error) {
          if (status.error.toLowerCase().includes("never placed") ||
              status.error.toLowerCase().includes("already cancel") ||
              status.error.toLowerCase().includes("filled")) {
            log(botId, `  ↳ ${tag} already gone (${status.error})`, "info");
            ok++;
          } else {
            log(botId, `  ↳ FAILED ${tag}: ${status.error}`, "warn");
            fail++;
          }
        } else {
          log(botId, `  ↳ ? ${tag}: ${JSON.stringify(status)}`, "warn");
          fail++;
        }
      }
      if (fail === 0) {
        log(botId, `✅ All ${ok} order(s) cancelled via native SDK`, "success");
      } else {
        log(botId, `⚠️ Native SDK summary: ${ok} OK, ${fail} FAILED`, "warn");
      }
    }
    bot.openOrders = [];
    bot.pendingRoundTrips = [];
    return;
  }

  // ── DEFAULT PATH (Binance, Deribit): use CCXT ──────────────────────
  // Try bulk cancel first, wrapped with timeout.
  try {
    await Promise.race([
      bot.exchange.cancelAllOrders(cfg.symbol),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cancelAllOrders timeout 5s")), 5000)),
    ]);
    log(botId, `Bulk cancel succeeded`, "success");
    bot.openOrders = [];
    bot.pendingRoundTrips = [];
    return;
  } catch (err) {
    log(botId, `Bulk cancel ${err.message.includes("timeout") ? "timed out" : "not supported"}: ${err.message} — using per-order cancels`, "warn");
  }

  // Per-order cancellation. Each cancelOrder call is wrapped in its own
  // 5-second timeout so a single bad call can't stall the whole sequence.
  let successCount = 0, failCount = 0;
  for (const o of toCancel) {
    try {
      await Promise.race([
        bot.exchange.cancelOrder(o.id, cfg.symbol),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 5s")), 5000)),
      ]);
      bot.recentlyCancelled = bot.recentlyCancelled || {};
      bot.recentlyCancelled[o.id] = Date.now();
      log(botId, `  ↳ Cancelled ${o.side?.toUpperCase()} @ $${o.price}  id:${String(o.id).slice(0,16)}`, "info");
      successCount++;
    } catch (e) {
      // "Order was never placed, already canceled, or filled" = success in disguise
      const msg = (e.message || "").toLowerCase();
      if (msg.includes("never placed") || msg.includes("already cancel") || msg.includes("filled")) {
        log(botId, `  ↳ ${o.side?.toUpperCase()} @ $${o.price} already gone (${e.message})`, "info");
        successCount++;
      } else {
        log(botId, `  ↳ FAILED ${o.side?.toUpperCase()} @ $${o.price}: ${e.message}`, "warn");
        failCount++;
      }
    }
    // Always remove from local tracking
    bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
  }

  if (failCount === 0) {
    log(botId, `✅ All ${successCount} order(s) cancelled`, "success");
  } else {
    log(botId, `⚠️ Cancel summary: ${successCount} OK, ${failCount} FAILED — check Hyperliquid web UI manually`, "error");
  }

  bot.openOrders = [];
  bot.pendingRoundTrips = [];
}

async function syncOrdersFromExchange(botId) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  const cfg = bot.config;

  // ── HYPERLIQUID: native orphan cleanup ──
  // CCXT's fetchOpenOrders is broken, but the native SDK works. Any order
  // LIVE on the exchange that we are NOT tracking locally is an orphan
  // (lost-track order) — cancel it so they can't pile up and exhaust margin.
  if (exchangeKey === "hyperliquid") {
    const cache = bot.hlCache;
    if (!cache?.infoClient) return;
    const wallet = process.env.HYPERLIQUID_WALLET_ADDRESS;
    let exchangeOrders;
    try {
      exchangeOrders = await Promise.race([
        cache.infoClient.openOrders({ user: wallet }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("openOrders timeout 5s")), 5000)),
      ]);
    } catch (e) {
      log(botId, `Orphan check skipped: ${e.message}`, "warn");
      return;
    }
    const ourCoinId = cache.coinId;
    const ours = exchangeOrders.filter(o => o.coin === ourCoinId);
    const trackedIds = new Set(bot.openOrders.map(o => String(o.id)));

    // Don't flag orphans right after we placed orders — the exchange may
    // not have indexed our newest orders yet, and they'd look "untracked".
    const lastPlace = Math.max(0, ...bot.openOrders.map(o => o.placedAt || 0));
    if (Date.now() - lastPlace < 15000) return;

    const orphans = ours.filter(o => !trackedIds.has(String(o.oid)));
    if (orphans.length > 0) {
      log(botId, `Found ${orphans.length} orphan order(s) on exchange — cancelling to prevent pile-up`, "warn");
      const ids = orphans.map(o => o.oid);
      const result = await hyperliquidNativeCancel(bot, ids);
      if (result.ok) {
        log(botId, `Cleared ${orphans.length} orphan(s)`, "success");
      } else {
        log(botId, `Orphan cancel failed: ${result.error}`, "warn");
      }
    }
    return;
  }

  const GRACE_MS = 30_000;       // ignore orphan-style mismatches for orders this fresh
  const now      = Date.now();
  try {
    const exchangeOrders = await bot.exchange.fetchOpenOrders(cfg.symbol);
    const exchangeIds    = new Set(exchangeOrders.map(o => o.id));
    const trackedIds     = new Set(bot.openOrders.map(o => o.id));

    // ── Garbage-collect stale recentlyCancelled entries ──
    bot.recentlyCancelled = bot.recentlyCancelled || {};
    for (const id of Object.keys(bot.recentlyCancelled)) {
      if (now - bot.recentlyCancelled[id] > GRACE_MS) delete bot.recentlyCancelled[id];
    }

    // ── Cancel TRUE orphans (on exchange, not tracked, and not recently cancelled by us) ──
    // The recently-cancelled filter prevents re-cancelling orders that we
    // just cancelled but Deribit's fetchOpenOrders hasn't propagated yet.
    const orphans = exchangeOrders.filter(o =>
      !trackedIds.has(o.id) && !bot.recentlyCancelled[o.id]
    );
    if (orphans.length > 0) {
      log(botId, `Found ${orphans.length} orphan orders on exchange — cancelling`, "warn");
      for (const o of orphans) {
        const ok = await cancelSingleOrder(botId, o.id, cfg.symbol);
        if (ok) bot.recentlyCancelled[o.id] = now;
      }
    }

    // ── Locally-tracked orders missing from the exchange ──
    // Skip orders placed in the last 30s — Deribit may not have propagated
    // them to fetchOpenOrders yet, so they look "missing" but they're really fine.
    const missingFromExchange = bot.openOrders.filter(o =>
      !exchangeIds.has(o.id) && (now - (o.placedAt || 0) > GRACE_MS)
    );
    for (const o of missingFromExchange) {
      try {
        const order = await bot.exchange.fetchOrder(o.id, cfg.symbol);
        if (order.status === "closed" || order.status === "filled") {
          // It filled — let checkAndHandleFills logic handle it on the next loop.
          log(botId, `Sync detected filled order: ${o.type.toUpperCase()} ${o.side.toUpperCase()} @ $${o.price} (will be processed next loop)`, "info");
          // DON'T remove from openOrders yet — let checkAndHandleFills process it.
        } else if (order.status === "canceled" || order.status === "cancelled") {
          // External cancel — clean up
          if (o.type === "target") {
            const orphaned = bot.pendingRoundTrips.filter(rt => rt.targetOrderId === o.id);
            if (orphaned.length > 0) {
              bot.pendingRoundTrips = bot.pendingRoundTrips.filter(rt => rt.targetOrderId !== o.id);
              log(botId, `Sync: target ${o.id} was cancelled externally — discarded ${orphaned.length} pending RT(s)`, "warn");
            }
          }
          bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
        }
      } catch (err) {
        log(botId, `Sync fetchOrder failed for ${o.id}: ${err.message}`, "warn");
      }
    }
  } catch (err) {
    log(botId, `sync failed: ${err.message}`, "warn");
  }
}

// ============================================================
//  STATS / REPORT
// ============================================================
function calcLiveStats(exchangeKey) {
  const bot = bots[exchangeKey];
  const fills = bot.fillHistory;
  const buys  = fills.filter(f => f.side === "buy");
  const sells = fills.filter(f => f.side === "sell");
  const buyAvg  = buys.length  ? buys.reduce((s,f)  => s + f.price, 0) / buys.length  : null;
  const sellAvg = sells.length ? sells.reduce((s,f) => s + f.price, 0) / sells.length : null;

  // SINGLE SOURCE OF TRUTH: completedRoundTrips
  // Each entry is created when a target order fills against a tracked entry order,
  // so this is the ACTUAL count and PnL — not an estimate based on min(buys, sells).
  const completed = bot.completedRoundTrips || [];
  const rt        = completed.length;
  const grossPnl  = completed.reduce((s, x) => s + (x.grossPnl ?? x.pnl ?? 0), 0);
  const rtFees    = completed.reduce((s, x) => s + (x.totalFee || 0), 0);
  const netPnl    = grossPnl - rtFees;

  const qty = bot.config?.qtyPerStep    || 0;
  const tsp = bot.config?.targetSpread  || 0;

  let totalFees = 0;
  for (const f of fills) totalFees += (f.fee || 0);

  return {
    totalPnl       : parseFloat(grossPnl.toFixed(4)),   // gross (kept for backward compat)
    grossPnl       : parseFloat(grossPnl.toFixed(4)),
    rtFees         : parseFloat(rtFees.toFixed(4)),
    netPnl         : parseFloat(netPnl.toFixed(4)),
    buyAvg         : buyAvg  ? parseFloat(buyAvg.toFixed(4))  : null,
    sellAvg        : sellAvg ? parseFloat(sellAvg.toFixed(4)) : null,
    totalRoundTrips: rt,
    pendingLegs    : bot.pendingRoundTrips.length,
    totalBuys      : buys.length,
    totalSells     : sells.length,
    totalFills     : fills.length,
    targetSpread   : tsp,
    qtyPerStep     : qty,
    perRtPnl       : parseFloat((tsp * qty).toFixed(4)),
    totalFees      : parseFloat(totalFees.toFixed(6)),
  };
}

function getRoundTripReport(exchangeKey, fromTs, toTs) {
  const bot = bots[exchangeKey];
  const tsp = bot.config?.targetSpread || 0;
  const qty = bot.config?.qtyPerStep   || 0;

  // SINGLE SOURCE OF TRUTH: completedRoundTrips, filtered by closeTs in [fromTs, toTs]
  const completed = (bot.completedRoundTrips || []).filter(rt => {
    const t = new Date(rt.closeTs).getTime();
    return t >= fromTs && t <= toTs;
  });

  const rows = completed.map(rt => ({
    openSide  : rt.openSide.toUpperCase(),
    buyPrice  : rt.buyPrice  ?? (rt.openSide === "buy"  ? rt.openPrice : rt.closePrice),
    sellPrice : rt.sellPrice ?? (rt.openSide === "sell" ? rt.openPrice : rt.closePrice),
    qty       : rt.qty,
    pnl       : rt.pnl,
    openTs    : rt.openTs,
    closeTs   : rt.closeTs,
    durationMs: rt.durationMs,
  })).sort((a, b) => new Date(b.closeTs) - new Date(a.closeTs));

  const rt  = rows.length;
  const pnl = parseFloat(rows.reduce((s, r) => s + (r.pnl || 0), 0).toFixed(4));
  const perRtPnl = rt > 0 ? parseFloat((pnl / rt).toFixed(6)) : parseFloat((tsp * qty).toFixed(6));

  // Average actual spread between paired buy/sell (real market behavior — not the configured target)
  const avgSpread = rt > 0
    ? parseFloat((rows.reduce((s, r) => s + (r.sellPrice - r.buyPrice), 0) / rt).toFixed(6))
    : 0;

  // Fee/rebate info still comes from fillHistory (per-fill data)
  const periodFills = bot.fillHistory.filter(f => {
    const t = new Date(f.ts).getTime();
    return t >= fromTs && t <= toTs;
  });
  const periodBuys  = periodFills.filter(f => f.side === "buy").length;
  const periodSells = periodFills.filter(f => f.side === "sell").length;

  let totalFees = 0, totalRebates = 0;
  for (const f of periodFills) {
    const fee = f.fee || 0;
    if (fee > 0) totalFees += fee;
    else         totalRebates += -fee;
  }
  const netPnl = parseFloat((pnl - totalFees + totalRebates).toFixed(6));

  return {
    count: rt, pnl,
    wins: rows.filter(r => r.pnl > 0).length,
    losses: rows.filter(r => r.pnl < 0).length,
    winRate: rt > 0 ? Math.round(rows.filter(r => r.pnl > 0).length / rt * 100) : 0,
    roundTrips: rows,
    periodBuys, periodSells, perRtPnl, avgSpread,
    totalFees   : parseFloat(totalFees.toFixed(6)),
    totalRebates: parseFloat(totalRebates.toFixed(6)),
    netPnl,
  };
}

// ============================================================
//  CSV REPORT BUILDER
//  Builds the CSV payload for /api/csv and Telegram download.
//  Layout:
//    Header: summary metadata (totals + config)
//    Blank line
//    Detail: per-round-trip rows
// ============================================================
function buildCsvReport(exchangeKey, fromTs, toTs) {
  const bot = bots[exchangeKey];
  const cfg = bot.config || {};
  const r   = getRoundTripReport(exchangeKey, fromTs, toTs);

  // Helper: CSV-safe field (escapes commas, quotes, newlines)
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [];

  // ── SUMMARY HEADER ─────────────────────────────────────
  lines.push("# GRID BOT 24H PNL REPORT");
  lines.push(`# Exchange,${esc(exchangeKey)}`);
  lines.push(`# Symbol,${esc(cfg.symbol || "")}`);
  lines.push(`# Period from,${esc(new Date(fromTs).toISOString())}`);
  lines.push(`# Period to,${esc(new Date(toTs).toISOString())}`);
  lines.push(`# Generated,${esc(new Date().toISOString())}`);
  lines.push("");

  // Summary metrics row (the columns you asked for in point 4)
  lines.push("RTPS,TOTAL_PNL,PER_STEP_QTY,AVG_SPREAD,TARGET_SPREAD,DISTANCE,TOTAL_FEES,TOTAL_REBATES,NET_PNL");
  lines.push([
    r.count,
    r.pnl.toFixed(6),
    cfg.qtyPerStep ?? "",
    r.avgSpread.toFixed(6),
    cfg.targetSpread ?? "",
    cfg.distance ?? "",
    r.totalFees.toFixed(6),
    r.totalRebates.toFixed(6),
    r.netPnl.toFixed(6),
  ].map(esc).join(","));
  lines.push("");

  // ── DETAIL ROWS ────────────────────────────────────────
  // Each round trip shows the consecutive buy AND sell side-by-side, with PnL.
  // "Open side" tells you which leg fired first (buy entry then sell target, or sell entry then buy target).
  lines.push("ROUND_TRIP,OPEN_SIDE,BUY_PRICE,SELL_PRICE,QTY,SPREAD,PNL,DURATION_SEC,OPENED_AT,CLOSED_AT");

  // Sort detail rows by close time ascending so the CSV reads chronologically top-to-bottom
  const orderedRows = [...r.roundTrips].sort((a, b) => new Date(a.closeTs) - new Date(b.closeTs));

  orderedRows.forEach((rt, idx) => {
    const spread   = (rt.sellPrice - rt.buyPrice).toFixed(6);
    const durSec   = ((rt.durationMs || 0) / 1000).toFixed(1);
    const openedAt = new Date(rt.openTs).toISOString();
    const closedAt = new Date(rt.closeTs).toISOString();
    lines.push([
      idx + 1,
      rt.openSide,
      rt.buyPrice.toFixed(6),
      rt.sellPrice.toFixed(6),
      rt.qty,
      spread,
      rt.pnl.toFixed(6),
      durSec,
      openedAt,
      closedAt,
    ].map(esc).join(","));
  });

  if (orderedRows.length === 0) {
    lines.push("# No round trips in this period");
  }

  return lines.join("\n");
}

// ============================================================
//  DERIBIT FEES REFRESH
//  Pulls real fee/rebate data from Deribit user trades and
//  merges it into bot.fillHistory by orderId.
// ============================================================
async function refreshDeribitFees() {
  const bot = bots.deribit;
  if (!bot.exchange || !bot.config) return;
  try {
    const trades = await bot.exchange.fetchMyTrades(bot.config.symbol, undefined, 200);
    const byOrderId = {};
    for (const t of trades) {
      const oid = t.order || t.info?.order_id;
      if (!oid) continue;
      const fee = parseFloat(t.fee?.cost ?? 0);
      byOrderId[oid] = (byOrderId[oid] || 0) + fee;
    }
    let updated = 0;
    for (const f of bot.fillHistory) {
      if (f.orderId && byOrderId[f.orderId] !== undefined) {
        f.fee = byOrderId[f.orderId];
        updated++;
      }
    }
    if (updated > 0) log("deribit", `Refreshed fees for ${updated} fills`);
  } catch (err) {
    log("deribit", `Fee refresh failed: ${err.message}`, "warn");
  }
}

// ============================================================
//  STATE SNAPSHOT
// ============================================================
function buildStateSnapshot() {
  const snap = {};
  for (const key of Object.keys(bots)) {
    const b = bots[key];
    b.stats = calcLiveStats(key);
    snap[key] = {
      botId               : b.botId || key,
      exchangeKey         : b.exchangeKey,
      label               : b.label || key,
      running             : b.running,
      startedAt           : b.startedAt || null,
      runtimeMs           : b.startedAt && b.running ? Date.now() - b.startedAt : 0,
      runtimeStr          : b.startedAt && b.running ? formatDuration(Date.now() - b.startedAt) : "—",
      lastPrice           : b.lastPrice,
      entryPrice          : b.entryPrice,
      upperLimit          : b.upperLimit,
      lowerLimit          : b.lowerLimit,
      openOrders          : b.openOrders,
      fillHistory         : b.fillHistory.slice(0, 50),
      completedRoundTrips : b.completedRoundTrips.slice(0, 50),
      pendingRoundTrips   : b.pendingRoundTrips,
      stats               : b.stats,
      logsRecent          : b.logs.slice(0, 50),
      symbol              : b.config?.symbol || null,
      priceSource         : b.config?.priceSource || null,
      hedge               : b.exchangeKey === "binance" ? {
        enabled         : b.hedge.enabled,
        spotInventory   : b.hedge.spotInventory,
        currentShortQty : b.hedge.currentShortQty,
        targetShortQty  : b.hedge.targetShortQty,
        lastCheckTs     : b.hedge.lastCheckTs,
        lastRebalanceTs : b.hedge.lastRebalanceTs,
        symbol          : b.hedge.symbol,
        log             : b.hedge.log.slice(0, 20),
      } : { enabled: false },
    };
  }
  return snap;
}

// ============================================================
//  API ROUTES
// ============================================================
app.get("/api/status", (req, res) => res.json(buildStateSnapshot()));

// List all bot instances (for the dynamic dashboard)
app.get("/api/bots", (req, res) => {
  const list = listBots().map(b => ({
    botId       : b.botId,
    exchangeKey : b.exchangeKey,
    label       : b.label || b.botId,
    running     : b.running,
    symbol      : b.config?.symbol || null,
    priceSource : b.config?.priceSource || null,
    isLegacy    : (b.botId === "binance" || b.botId === "deribit" || b.botId === "hyperliquid"),
    logFile     : `logs/${b.botId}.log`,
    tailCmd     : `tail -f logs/${b.botId}.log`,
  }));
  res.json(list);
});

// List existing per-bot log files (helps users find what to tail)
app.get("/api/logs/files", (req, res) => {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith(".log"))
      .map(f => ({
        botId: f.replace(/\.log$/, ""),
        path: `logs/${f}`,
        tailCmd: `tail -f logs/${f}`,
        sizeBytes: (fs.statSync(path.join(LOG_DIR, f)).size) || 0,
      }));
    res.json({ logDir: LOG_DIR, files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a stopped bot instance
app.post("/api/bot/delete", (req, res) => {
  const botId = req.body?.botId || req.query?.botId;
  if (!botId || !bots[botId]) return res.status(400).json({ error: "Unknown bot" });
  if (bots[botId].running) return res.status(400).json({ error: "Stop the bot before deleting" });
  removeBotInstance(botId);
  broadcast("state", buildStateSnapshot());
  res.json({ success: true, botId });
});

// Server-side config flags the frontend needs to know about
app.get("/api/config", (req, res) => {
  res.json({
    deribitTestnet     : String(process.env.DERIBIT_TESTNET || "").toLowerCase() === "true",
    binanceTestnet     : String(process.env.BINANCE_TESTNET || "").toLowerCase() === "true",
    hyperliquidTestnet : String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true",
  });
});

app.get("/api/report", async (req, res) => {
  const exchangeKey = req.query.botId || req.query.exchange || "binance";
  if (!bots[exchangeKey]) return res.status(400).json({ error: "Unknown exchange" });

  const now    = Date.now();
  const period = req.query.period || "24h";
  let fromTs, toTs = now;
  if (period === "24h")      fromTs = now - 24 * 60 * 60 * 1000;
  else if (period === "7d")  fromTs = now - 7  * 24 * 60 * 60 * 1000;
  else if (period === "30d") fromTs = now - 30 * 24 * 60 * 60 * 1000;
  else if (period === "custom") {
    fromTs = parseInt(req.query.from) || (now - 24 * 60 * 60 * 1000);
    toTs   = parseInt(req.query.to)   || now;
  } else fromTs = now - 24 * 60 * 60 * 1000;

  if (exchangeKey === "deribit") await refreshDeribitFees().catch(()=>{});

  res.json({ period, fromTs, toTs, exchange: exchangeKey, ...getRoundTripReport(exchangeKey, fromTs, toTs) });
});

// DB-backed report — reads from MySQL so history survives restarts.
// Same response shape as /api/report.
app.get("/api/db_report", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  const exchange = req.query.exchange || req.query.botId || null;
  const now = Date.now();
  const period = req.query.period || "24h";
  let fromTs, toTs = now;
  if (period === "24h")      fromTs = now - 24 * 60 * 60 * 1000;
  else if (period === "7d")  fromTs = now - 7  * 24 * 60 * 60 * 1000;
  else if (period === "30d") fromTs = now - 30 * 24 * 60 * 60 * 1000;
  else if (period === "all") fromTs = 0;
  else if (period === "custom") {
    fromTs = parseInt(req.query.from) || (now - 24 * 60 * 60 * 1000);
    toTs   = parseInt(req.query.to)   || now;
  } else fromTs = now - 24 * 60 * 60 * 1000;

  try {
    const report = await db.queryReport({ exchange, fromTs, toTs });
    if (!report) return res.status(503).json({ error: "DB unavailable" });
    res.json({ period, fromTs, toTs, exchange, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CSV download (browser) — same period semantics as /api/report
app.get("/api/csv", async (req, res) => {
  const exchangeKey = req.query.botId || req.query.exchange || "binance";
  if (!bots[exchangeKey]) return res.status(400).json({ error: "Unknown exchange" });

  const now    = Date.now();
  const period = req.query.period || "24h";
  let fromTs, toTs = now;
  if (period === "24h")      fromTs = now - 24 * 60 * 60 * 1000;
  else if (period === "7d")  fromTs = now - 7  * 24 * 60 * 60 * 1000;
  else if (period === "30d") fromTs = now - 30 * 24 * 60 * 60 * 1000;
  else if (period === "custom") {
    fromTs = parseInt(req.query.from) || (now - 24 * 60 * 60 * 1000);
    toTs   = parseInt(req.query.to)   || now;
  } else fromTs = now - 24 * 60 * 60 * 1000;

  if (exchangeKey === "deribit") await refreshDeribitFees().catch(()=>{});

  const csv = buildCsvReport(exchangeKey, fromTs, toTs);
  const dateStr  = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const filename = `gridbot_${exchangeKey}_${period}_${dateStr}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

app.get("/api/logs", (req, res) => {
  const exchangeKey = req.query.botId || req.query.exchange;
  if (exchangeKey && bots[exchangeKey]) return res.json(bots[exchangeKey].logs);
  const all = [...bots.binance.logs, ...bots.deribit.logs];
  all.sort((a,b) => new Date(b.ts) - new Date(a.ts));
  res.json(all.slice(0, 200));
});

app.post("/api/start", async (req, res) => {
  const cfg = req.body;
  const priceSource = cfg.priceSource;
  // Determine the exchange family
  let exchangeKey;
  if (priceSource === "deribit" || priceSource === "deribit_spot") {
    exchangeKey = "deribit";
  } else if (priceSource === "hyperliquid" || priceSource === "hyperliquid_spot" || priceSource === "hyperliquid_hip3") {
    exchangeKey = "hyperliquid";
  } else {
    exchangeKey = "binance";
  }

  // ── DYNAMIC BOT INSTANCE ──
  // First bot of an exchange (when the legacy slot is free) reuses the
  // legacy slot — keeps Binance hedge + Telegram menus working. Additional
  // bots get a fresh unique instance so many run simultaneously.
  let bot, botId;
  const legacy = bots[exchangeKey];
  if (legacy && !legacy.running) {
    bot   = legacy;
    botId = exchangeKey;
    // refresh the legacy slot
    bots[exchangeKey] = makeFreshBot(exchangeKey, exchangeKey);
    bot   = bots[exchangeKey];
  } else {
    const lbl = `${cfg.symbol || exchangeKey} ${priceSource.includes("spot") ? "Spot" : priceSource.includes("hyperliquid") ? "Perp" : ""}`.trim();
    bot   = createBotInstance(exchangeKey, lbl);
    botId = bot.botId;
  }
  bot.label = `${cfg.symbol || exchangeKey}`;

  injectKeysIntoCfg(exchangeKey, cfg);

  if (!cfg.apiKey || !cfg.secretKey) {
    removeBotInstance(botId);
    const which = exchangeKey === "deribit"
      ? "DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET"
      : exchangeKey === "hyperliquid"
      ? "HYPERLIQUID_WALLET_ADDRESS / HYPERLIQUID_PRIVATE_KEY"
      : "BINANCE_API_KEY / BINANCE_SECRET_KEY";
    return res.status(400).json({ error: `${which} missing in .env file` });
  }

  const required = ["priceSource","symbol","distance","avgSellSpacing","avgBuySpacing","targetSpread","qtyPerStep"];
  for (const f of required) {
    if (!cfg[f] && cfg[f] !== 0) { removeBotInstance(botId); return res.status(400).json({ error: `Missing field: ${f}` }); }
  }

  cfg.distance       = parseFloat(cfg.distance);
  cfg.avgSellSpacing = parseFloat(cfg.avgSellSpacing);
  cfg.avgBuySpacing  = parseFloat(cfg.avgBuySpacing);
  cfg.targetSpread   = parseFloat(cfg.targetSpread);
  cfg.qtyPerStep     = parseFloat(cfg.qtyPerStep);

  try {
    const exchange = buildExchange(priceSource, cfg.apiKey, cfg.secretKey);
    await exchange.loadMarkets();
    if (exchangeKey === "binance") await syncExchangeTime(exchange);

    // For Hyperliquid: pre-warm the native SDK BEFORE the startup ticker,
    // because CCXT's fetchTicker is broken for Hyperliquid (consistent
    // timeouts). Once hlCache exists, getTickerSnapshot uses native l2Book.
    if (exchangeKey === "hyperliquid") {
      try {
        const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
        const wallet     = privateKeyToAccount(process.env.HYPERLIQUID_PRIVATE_KEY);
        const transport  = new hl.HttpTransport({ isTestnet: useTestnet });
        const exchClient = new hl.ExchangeClient({ wallet, transport, isTestnet: useTestnet });
        const infoClient = new hl.InfoClient({ transport });

        const isSpot = (cfg.priceSource === "hyperliquid_spot");
        const base   = cfg.symbol.split("/")[0];
        let assetIndex = -1, szDecimals = 4, maxSig = 5, coinId = base;
        if (isSpot) {
          const m = await infoClient.spotMeta();
          for (let i = 0; i < m.universe.length; i++) {
            const baseToken = m.tokens[m.universe[i].tokens[0]];
            if (baseToken?.name === base) {
              assetIndex = 10000 + m.universe[i].index;
              szDecimals = baseToken.szDecimals ?? 4;
              maxSig = 8;
              coinId = m.universe[i].name;
              break;
            }
          }
        } else {
          let m;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { m = await infoClient.meta(); break; }
            catch (me) {
              if (/429|too many/i.test(me.message || "") && attempt < 2) {
                log(botId, `Pre-warm meta() rate-limited, retrying in 4s (attempt ${attempt+1}/3)`, "warn");
                await new Promise(r => setTimeout(r, 4000));
              } else throw me;
            }
          }
          for (let i = 0; i < m.universe.length; i++) {
            if (m.universe[i].name === base) {
              assetIndex = i;
              szDecimals = m.universe[i].szDecimals ?? 4;
              maxSig = 5;
              coinId = m.universe[i].name;
              break;
            }
          }
        }
        if (assetIndex < 0) throw new Error(`Asset ${base} not found in Hyperliquid universe`);
        bot.hlCache = { exchClient, infoClient, assetIndex, base, coinId, szDecimals, maxSig, isSpot };
        bot.exchange = exchange;  // also needed for non-HL paths
        log(botId, `Hyperliquid SDK pre-warmed: ${base} idx=${assetIndex} coin=${coinId} szDec=${szDecimals} sig=${maxSig}${isSpot ? " [SPOT]" : " [PERP]"}`, "info");
      } catch (e) {
        log(botId, `Hyperliquid SDK pre-warm failed: ${e.message}`, "warn");
      }
    }

    // Startup ticker. For Hyperliquid uses native l2Book (CCXT fetchTicker
    // is broken). Retry once if it times out.
    let tick;
    try {
      tick = await getTickerSnapshot(exchange, cfg.symbol, 15000, bot);
    } catch (e) {
      if (/timeout/i.test(e.message)) {
        log(botId, `First ticker fetch timed out, retrying once...`, "warn");
        tick = await getTickerSnapshot(exchange, cfg.symbol, 20000, bot);
      } else throw e;
    }
    let entryPrice = tick.last;
    let upperLimit = parseFloat((entryPrice + cfg.distance).toFixed(8));
    let lowerLimit = parseFloat((entryPrice - cfg.distance).toFixed(8));

    Object.assign(bot, {
      botId, exchangeKey,
      config: cfg, exchange, entryPrice, lastPrice: entryPrice,
      bestBid: tick.bid, bestAsk: tick.ask,
      upperLimit, lowerLimit, running: true, startedAt: Date.now(),
      openOrders: [], fillHistory: [], pendingRoundTrips: [],
      completedRoundTrips: [], logs: [], loopCount: 0, lastNotifiedRt: 0, gridAnchor: null,
    });

    // Hedge only for Binance
    if (exchangeKey === "binance" && cfg.hedgeEnabled) {
      const futKey    = process.env.FUTURES_API_KEY    || cfg.apiKey;
      const futSecret = process.env.FUTURES_SECRET_KEY || cfg.secretKey;
      if (futKey && futSecret) {
        const futEx = new ccxt.binancecoinm({
          apiKey: futKey, secret: futSecret,
          adjustForTimeDifference: false, recvWindow: 60000,
          options: { recvWindow: 60000, defaultType: "delivery" },
        });
        futEx.fetchCurrencies = async () => ({});
        futEx.currencies = {};
        await futEx.loadMarkets();
        await syncExchangeTime(futEx);
        const base = cfg.symbol.split("/")[0];
        bot.hedge = {
          enabled: true, futuresExchange: futEx,
          currentShortQty: 0, targetShortQty: 0, spotInventory: 0,
          lastCheckTs: 0, lastRebalanceTs: 0,
          symbol: `${base}/USD:${base}`, log: [],
        };
        log(botId, `Hedge enabled: ${bot.hedge.symbol}`, "success");
      }
    }

    // True-continuation resume: restore in-memory state and DO NOT touch
    // open orders. Frontend never sets these — only resumeSessions does.
    const isResume   = req.body?.resume === true;
    const resumeState = req.body?._resumeState || null;

    if (isResume && resumeState) {
      if (Array.isArray(resumeState.openOrders))          bot.openOrders          = resumeState.openOrders;
      if (Array.isArray(resumeState.pendingRoundTrips))   bot.pendingRoundTrips   = resumeState.pendingRoundTrips;
      if (Array.isArray(resumeState.completedRoundTrips)) bot.completedRoundTrips = resumeState.completedRoundTrips;
      if (Array.isArray(resumeState.fillHistory))         bot.fillHistory         = resumeState.fillHistory;
      if (resumeState.gridAnchor     != null) bot.gridAnchor     = resumeState.gridAnchor;
      if (resumeState.upperLimit     != null) upperLimit         = resumeState.upperLimit;
      if (resumeState.lowerLimit     != null) lowerLimit         = resumeState.lowerLimit;
      if (resumeState.entryPrice     != null) entryPrice         = resumeState.entryPrice;
      if (resumeState.lastPrice      != null) bot.lastPrice      = resumeState.lastPrice;
      if (resumeState.lastNotifiedRt != null) bot.lastNotifiedRt = resumeState.lastNotifiedRt;
      if (resumeState.startedAt      != null) bot.startedAt      = resumeState.startedAt;
      bot.upperLimit = upperLimit;
      bot.lowerLimit = lowerLimit;
      bot.entryPrice = entryPrice;
      log(botId, `Resuming previous session — ${bot.openOrders.length} open orders, ${bot.pendingRoundTrips.length} pending RTs, ${bot.completedRoundTrips.length} completed RTs restored`, "success");
    } else {
      log(botId, `Cancelling leftover orders...`);
      try { await exchange.cancelAllOrders(cfg.symbol); }
      catch(e) {
        try {
          const prev = await exchange.fetchOpenOrders(cfg.symbol);
          for (const o of prev) { try{ await exchange.cancelOrder(o.id, cfg.symbol); }catch(_){} }
        } catch(_){}
      }
    }

    log(botId, isResume ? `Bot resumed! Symbol: ${cfg.symbol}` : `Bot started! Entry: $${entryPrice} | ${cfg.symbol}`, "success");
    log(botId, `Upper: $${upperLimit}  |  Lower: $${lowerLimit}`);
    log(botId, `📄 Per-bot log: tail -f logs/${botId}.log`, "info");
    // Live dashboard always starts at zero — DB-backed history lives in
    // the PnL Report tab (via /api/db_report).

    // Spot inventory advisory
    if (exchangeKey === "hyperliquid" && bot.hlCache?.isSpot) {
      const recommended = (cfg.qtyPerStep * 3).toFixed(4);
      const base = bot.hlCache.base;
      try {
        const bal = await bot.exchange.fetchBalance();
        const freeBase = parseFloat(bal?.[base]?.free ?? bal?.free?.[base] ?? 0);
        log(botId, `SPOT mode: you hold ${freeBase.toFixed(4)} ${base}. Recommended ≥ ${recommended} ${base} so all 3 sell slots can be placed.`, freeBase >= cfg.qtyPerStep ? "info" : "warn");
      } catch(e) {
        log(botId, `SPOT mode: hold ≥ ${recommended} ${base} so all 3 sell slots work.`, "info");
      }
    }

    const tag = EXCHANGE_TAG[exchangeKey];
    await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
      isResume
        ? `${tag} 🔄 Grid Bot Resumed\nSymbol: ${cfg.symbol}\nOpen orders: ${bot.openOrders.length}\nPending RTs: ${bot.pendingRoundTrips.length}\nTime: ${new Date().toLocaleString()}`
        : `${tag} Grid Bot Started\nSymbol: ${cfg.symbol}\nEntry: $${entryPrice}\nUpper: $${upperLimit}\nLower: $${lowerLimit}\nTime: ${new Date().toLocaleString()}`
    );

    // Initial grid placement only on a fresh start. On resume, the next
    // gridLoop iteration handles fill detection + grid maintenance using
    // the restored openOrders state.
    if (!isResume) await maintainGrid(botId, entryPrice);

    // Stagger startup AND scale the loop interval with how many bots run.
    // More bots → slower per-bot loop so aggregate API weight stays under
    // Hyperliquid's 1200/min limit. Also delay this bot's first loop so its
    // startup burst (meta + ticker + initial grid placement) doesn't collide
    // with other bots' in-flight loops.
    const runningCount = listBots().filter(b => b.running).length;
    // Churn is fixed (orders no longer re-placed every loop), so steady-state
    // API weight is low: ticker (w2) + fill-check (w20, every 2nd loop).
    // We can run tighter loops for faster order placement.
    const loopMs = runningCount <= 1 ? 4000
                 : runningCount === 2 ? 5000
                 : runningCount === 3 ? 7000
                 : 9000;
    const startupDelay = 2000 + (runningCount % 5) * 1500;  // 2s..8s
    setTimeout(() => {
      if (bot.running) bot.loopTimer = setInterval(() => gridLoop(botId), loopMs);
    }, startupDelay);
    log(botId, `Loop: ${loopMs}ms interval, first run in ${startupDelay}ms (${runningCount} bot(s) running)`, "info");

    // Persist the running session so it auto-resumes after deploy / reboot.
    // On resume the row already exists with config — don't overwrite, just
    // let the periodic state save in gridLoop refresh state_json.
    if (!isResume) db.saveSession(botId, exchangeKey, stripSecrets(req.body));

    res.json({ success: true, botId, exchange: exchangeKey, label: bot.label, entryPrice, upperLimit, lowerLimit });
  } catch (err) {
    const is429 = (err.message || "").includes("429") || /too many requests/i.test(err.message || "");
    const msg = is429
      ? "Hyperliquid rate limit hit (429). Wait ~60 seconds, then try again. Running fewer bots or a slower loop reduces this."
      : err.message;
    log(botId, `Start failed: ${msg}`, "error");
    bot.running = false;
    removeBotInstance(botId);
    res.status(is429 ? 429 : 500).json({ error: msg });
  }
});

app.post("/api/stop", async (req, res) => {
  const botId = req.body?.botId || req.query?.botId || req.body?.exchange || req.query?.exchange || "binance";
  if (!bots[botId]) return res.status(400).json({ error: "Unknown bot" });
  const bot = bots[botId];
  const exchangeKey = bot.exchangeKey;
  if (!bot.running) return res.json({ message: "Bot was not running" });

  // Set the flag FIRST so any in-flight gridLoop iteration sees it and bails.
  bot.running = false;
  clearInterval(bot.loopTimer);
  log(botId, `Manual stop — cancelling orders...`, "warn");

  try {
    await cancelAllOrders(botId);
    log(botId, `All orders cancelled.`, "success");
  } catch (err) { log(botId, `Cancel error: ${err.message}`, "warn"); }

  const tag = EXCHANGE_TAG[exchangeKey];
  await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID,
    `${tag} 🛑 Grid Bot Manually Stopped\n\nSymbol: ${bot.config?.symbol||"—"}\nLast Price: $${bot.lastPrice||"—"}\nTime: ${new Date().toLocaleString()}`
  );

  db.clearSession(botId);

  res.json({ success: true, botId, exchange: exchangeKey });
  broadcast("state", buildStateSnapshot());

  // Remove dynamic (non-legacy) bot instances after they stop, so the
  // dashboard doesn't accumulate dead bots. Legacy slots are reset.
  setTimeout(() => {
    if (!bots[botId]?.running) removeBotInstance(botId);
    broadcast("state", buildStateSnapshot());
  }, 5000);
});

// Hyperliquid account overview as structured JSON (native SDK, fast)
app.get("/api/hl_portfolio", async (req, res) => {
  const walletAddr = process.env.HYPERLIQUID_WALLET_ADDRESS;
  if (!walletAddr) return res.status(400).json({ error: "HYPERLIQUID_WALLET_ADDRESS missing" });
  try {
    const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
    const transport  = new hl.HttpTransport({ isTestnet: useTestnet });
    const info       = new hl.InfoClient({ transport });

    const [perpState, spotState] = await Promise.all([
      info.clearinghouseState({ user: walletAddr }).catch(() => null),
      info.spotClearinghouseState({ user: walletAddr }).catch(() => null),
    ]);

    // Perps USDC
    let perpTotal = 0, perpFree = 0;
    if (perpState?.marginSummary) {
      perpTotal = parseFloat(perpState.marginSummary.accountValue || 0);
      perpFree  = parseFloat(perpState.withdrawable || perpTotal);
    }

    // Spot tokens
    const spotTokens = [];
    let spotUsdc = 0;
    for (const b of (spotState?.balances || [])) {
      const total = parseFloat(b.total || 0);
      if (total > 0) {
        spotTokens.push({ coin: b.coin, total, hold: parseFloat(b.hold || 0) });
        if (b.coin === "USDC") spotUsdc += total;
      }
    }

    // Open perp positions
    const positions = [];
    for (const ap of (perpState?.assetPositions || [])) {
      const p = ap.position;
      if (!p) continue;
      const szi = parseFloat(p.szi || 0);
      if (szi === 0) continue;
      positions.push({
        coin: p.coin,
        side: szi > 0 ? "LONG" : "SHORT",
        size: Math.abs(szi),
        entryPx: parseFloat(p.entryPx || 0),
        uPnl: parseFloat(p.unrealizedPnl || 0),
      });
    }

    res.json({
      env: useTestnet ? "TESTNET" : "MAINNET",
      wallet: walletAddr,
      perpFree, perpTotal, spotUsdc,
      combined: perpTotal + spotUsdc,
      spotTokens, positions,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/portfolio", async (req, res) => {
  const exchangeKey = req.query.botId || req.query.exchange || "binance";
  try {
    let text;
    if (exchangeKey === "deribit")          text = await tgDeribitPortfolioText();
    else if (exchangeKey === "hyperliquid") text = await tgHyperliquidPortfolioText();
    else                                    text = await tgBinancePortfolioText();
    res.json({ exchange: exchangeKey, text });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Account overview (Binance only — preserved)
app.get("/api/account", async (req, res) => {
  try {
    const apiKey    = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    const futKey    = process.env.FUTURES_API_KEY    || apiKey;
    const futSecret = process.env.FUTURES_SECRET_KEY || secretKey;
    const livePrice = bots.binance.lastPrice || 0;
    if (!apiKey || !secretKey) return res.status(400).json({ error: "API keys not configured" });

    function spotRequest(path) {
      return new Promise((resolve, reject) => {
        const ts  = Date.now();
        const q   = `timestamp=${ts}&recvWindow=60000`;
        const sig = crypto.createHmac("sha256", secretKey).update(q).digest("hex");
        https.get({ host:"api.binance.com", path:`${path}?${q}&signature=${sig}`,
          headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"} }, (r) => {
          let d=""; r.on("data",c=>d+=c); r.on("end",()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} });
        }).on("error", reject);
      });
    }

    const spotBal = await spotRequest("/api/v3/account");
    const balances = spotBal.balances || [];
    const symbol = bots.binance.config?.symbol || "SOL/FDUSD";
    const base   = symbol.split("/")[0];
    const quote  = symbol.split("/")[1];
    const quoteBal = balances.find(b => b.asset === quote);
    const solBal   = balances.find(b => b.asset === base);
    const spotFdusd    = quoteBal ? parseFloat(quoteBal.free) + parseFloat(quoteBal.locked) : 0;
    const spotSolQty   = solBal   ? parseFloat(solBal.free)   + parseFloat(solBal.locked)   : 0;
    const spotSolValue = parseFloat((spotSolQty * livePrice).toFixed(2));

    let futuresBalance = null, futuresUnrealizedPnl = null;
    try {
      const futData = await dapiSignedRequest("/dapi/v1/account", futKey, futSecret);
      if (Array.isArray(futData.assets)) {
        const solAsset = futData.assets.find(a => a.asset === base);
        if (solAsset) {
          const walletBal  = parseFloat(solAsset.walletBalance  || 0);
          const unrealPnl  = parseFloat(solAsset.unrealizedProfit || 0);
          futuresBalance       = parseFloat((walletBal  * livePrice).toFixed(2));
          futuresUnrealizedPnl = parseFloat((unrealPnl  * livePrice).toFixed(2));
        }
      }
    } catch(e){}

    const totalUsd = parseFloat((spotFdusd + spotSolValue + (futuresBalance || 0)).toFixed(2));
    res.json({ spotFdusd, spotSolQty, spotSolValue, futuresBalance, futuresUnrealizedPnl, totalUsd, livePrice });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

wss.on("connection", (ws) => {
  console.log("Frontend connected");
  ws.send(JSON.stringify({ type: "state", data: buildStateSnapshot() }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Grid Bot (Multi-Exchange) running on port ${PORT}\n`);
  console.log(`  📄 Per-bot logs: ${LOG_DIR}/<botId>.log`);
  console.log(`     Tail any bot's stream:  tail -f ${LOG_DIR}/<botId>.log\n`);
  startTelegramPoller();
  db.pingDb().then(ok => { if (ok) resumeSessions(); });
});

// Re-launch any bot whose session was persisted to MySQL. Runs once on
// startup after the DB ping succeeds. Each resume is best-effort — if one
// fails, the others still try.
async function resumeSessions() {
  let sessions;
  try {
    sessions = await db.loadAllSessions();
  } catch (e) {
    console.error("[RESUME] loadAllSessions failed:", e.message);
    return;
  }
  if (!sessions || sessions.length === 0) return;
  console.log(`[RESUME] Found ${sessions.length} persisted session(s) — restarting...`);
  for (const s of sessions) {
    try {
      // True continuation: pass resume:true + the persisted state. /api/start
      // skips cancelAllOrders + initial maintainGrid when these are present.
      const r = await fetch(`http://127.0.0.1:${PORT}/api/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...s.config, resume: true, _resumeState: s.state }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        const restored = s.state
          ? ` (restored ${s.state.openOrders?.length || 0} orders, ${s.state.pendingRoundTrips?.length || 0} pending RTs)`
          : "";
        console.log(`[RESUME] ${s.botId} (${s.exchange}) resumed${restored}`);
      } else {
        console.error(`[RESUME] ${s.botId} failed: ${body.error || r.status}`);
      }
    } catch (e) {
      console.error(`[RESUME] ${s.botId} crashed during resume:`, e.message);
    }
  }
}

// Flush per-bot log streams on shutdown so the tail of each file is written
function flushLogs(reason) {
  console.log(`\n  Shutting down (${reason}). Flushing log streams...`);
  for (const id of Object.keys(logStreams)) {
    try { logStreams[id].end(); } catch(e) {}
  }
}
process.on("SIGINT",  () => { flushLogs("SIGINT");  setTimeout(() => process.exit(0), 100); });
process.on("SIGTERM", () => { flushLogs("SIGTERM"); setTimeout(() => process.exit(0), 100); });
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
const logBytes   = {};   // { botId: approx bytes written to the current file }
const LOG_MAX_BYTES = 10 * 1024 * 1024;   // rotate at 10 MB (keep one .1 backup)

function getLogStream(botId) {
  if (!logStreams[botId]) {
    const fp = path.join(LOG_DIR, `${botId}.log`);
    try { logBytes[botId] = fs.existsSync(fp) ? fs.statSync(fp).size : 0; } catch (e) { logBytes[botId] = 0; }
    logStreams[botId] = fs.createWriteStream(fp, { flags: "a" });
    // CRITICAL: without an error handler, a failed write (e.g. ENOSPC — disk
    // full) emits an unhandled 'error' event that crashes the whole process.
    logStreams[botId].on("error", (e) => { console.error(`[LOG] stream error (${botId}):`, e.message); });
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
// Prevent per-bot log files from growing unbounded and filling the disk.
// When over the cap, close + rename to <botId>.log.1 (one backup) and reopen.
function rotateLogIfNeeded(botId) {
  if ((logBytes[botId] || 0) < LOG_MAX_BYTES) return;
  const fp = path.join(LOG_DIR, `${botId}.log`);
  try {
    closeLogStream(botId);
    try { fs.renameSync(fp, fp + ".1"); } catch (e) {}   // overwrites any previous .1
    logBytes[botId] = 0;                                  // next getLogStream reopens fresh
  } catch (e) { /* ignore */ }
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

// New Next.js frontend (static export, built locally — see the migration
// commits for why) is now the site's DEFAULT homepage — Bot Configuration,
// Accounts, PnL Report, Active Bot, Options Dashboard. Registered after
// sessionAuthMiddleware, so it's gated by the same session-cookie auth as
// everything else. The classic dashboard's own index.html is reserved at
// the explicit /index.html path (below, registered first so it always wins
// that one path) for pages not yet migrated — Bot Logs, Add Strategy,
// Combined Simulator, Options Analysis — and as a fallback if something
// here breaks. Existing bookmarks to /index.html keep working unchanged.
app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Next's static export produces BOTH a route.html file AND a same-named
// route/ directory (RSC prefetch payloads) for every page — e.g.
// options-dashboard.html alongside options-dashboard/. express.static sees
// the directory first and 301-redirects to add a trailing slash, never
// reaching the real page. Resolve the .html file explicitly before falling
// through to static asset serving, mirroring the try_files pattern Next's
// own docs recommend for nginx.
const nextOutDir = path.join(__dirname, "frontend/out");
app.use((req, res, next) => {
  const urlPath = req.path === "/" ? "/index" : req.path.replace(/\/$/, "");
  const htmlPath = path.join(nextOutDir, urlPath + ".html");
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  next();
});
app.use(express.static(nextOutDir, { index: false }));
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
  // botIdCounter resets to 1 on every server restart, but a resumed session
  // can now occupy an arbitrary-looking id (e.g. "hyperliquid_5") that this
  // counter has no idea about — skip any id already taken so a fresh bot
  // can never collide with (and silently overwrite) a resumed one.
  let botId;
  do { botId = `${exchangeKey}_${++botIdCounter}`; } while (bots[botId]);
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
  hyperliquid_hip3  : 0.000144,  // HIP-3 perp dexs use same maker rate as HL perps
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
// Count running bots on an exchange (legacy slot + dynamic instances).
function runningCount(exchangeKey) {
  return botsForExchange(exchangeKey).filter(b => b.running).length;
}
function exchangeSelectorMenu(action) {
  // Show a 🟢/🔴 dot per exchange reflecting ANY running bot, plus a count
  // badge when more than one bot runs on that exchange.
  const lbl = (emoji, name, key) => {
    const n = runningCount(key);
    const dot = n > 0 ? "🟢" : "🔴";
    return `${emoji} ${name} ${dot}${n > 1 ? ` (${n})` : ""}`;
  };
  return [
    [
      {text:lbl("🟦","Binance","binance"),         callback_data:`pick_binance_${action}`},
      {text:lbl("🟧","Deribit","deribit"),         callback_data:`pick_deribit_${action}`},
    ],
    [
      {text:lbl("🟣","Hyperliquid","hyperliquid"), callback_data:`pick_hyperliquid_${action}`},
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

// Control-panel header showing each exchange's running-bot count (so multiple
// bots on one exchange — e.g. SPCX + HYPE on Hyperliquid — are visible).
function panelStatusText() {
  const line = (emoji, name, key) => {
    const n = runningCount(key);
    return `${emoji} ${name}: <b>${n > 0 ? `🟢 ${n} RUNNING` : "🔴 STOPPED"}</b>`;
  };
  return `👋 <b>Grid Bot Control Panel</b>\n\n` +
    `${line("🟦","Binance","binance")}\n` +
    `${line("🟧","Deribit","deribit")}\n` +
    `${line("🟣","Hyperliquid","hyperliquid")}\n\nChoose an action:`;
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

// When several bots run on one exchange, let the user pick which one. The
// callback_data is "bot:<botId>:<action>" — ":" delimited because dynamic
// botIds (e.g. "hyperliquid_2") contain underscores.
function botSelectorMenu(exchangeKey, action, list) {
  const rows = list.map(b => {
    const dot = b.running ? "🟢" : "🔴";
    return [{ text: `${coinShort(b.config?.symbol)} ${dot}`, callback_data: `bot:${b.botId}:${action}` }];
  });
  rows.push([{ text: "⬅ Back to Menu", callback_data: "main_menu" }]);
  return rows;
}

// Per-bot action menu (shown with a single bot's status).
function botMenu(botId) {
  const b = bots[botId];
  const e = b?.exchangeKey;
  return [
    [{text:"🔄 Refresh", callback_data:`bot:${botId}:status`}, {text:"⏹ Stop", callback_data:`bot:${botId}:stop`}],
    [{text:"💼 Portfolio", callback_data:`do_portfolio_${e}`}, {text:"📈 PnL Report", callback_data:`do_report_${e}`}],
    [{text:"⬅ Back", callback_data:"act_status"}],
  ];
}

// Short coin label from a stored symbol:
//   "HYPE/USDC:USDC"     -> "HYPE"
//   "xyz:SPCX/USDC:USDC" -> "SPCX"
//   "BTC-PERPETUAL"      -> "BTC-PERPETUAL"
function coinShort(sym) {
  if (!sym) return "—";
  let base = String(sym).split("/")[0];
  if (base.includes(":")) base = base.split(":").pop();
  return base;
}

// All bot instances (legacy slot + dynamic) for an exchange family. Running
// bots first. Used to drive the Telegram per-bot selector when several coins
// run on the same exchange.
function botsForExchange(exchangeKey) {
  return listBots()
    .filter(b => b.exchangeKey === exchangeKey)
    .sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0));
}

function tgStatusText(botId) {
  const s   = bots[botId];
  if (!s) return "Bot not found (it may have been stopped).";
  const tag = EXCHANGE_TAG[s.exchangeKey] || s.exchangeKey;
  const cfg = s.config;
  const coin = coinShort(cfg?.symbol);
  if (!s.running) return `<b>${tag} ${coin} — 🔴 STOPPED</b>\n\nBot is not running.\nTap 🔄 Restart to bring it back.`;
  const st = calcLiveStats(botId);
  const runtime = s.startedAt ? formatDuration(Date.now() - s.startedAt) : "—";
  const netPnl  = st.netPnl ?? st.totalPnl ?? 0;
  const netSign = netPnl >= 0 ? "+" : "";
  return `<b>${tag} ${coin} — 🟢 RUNNING</b>

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
      // Hyperliquid's accountValue on marginSummary = CROSS account only.
      // Isolated positions hold their own USDC pool in position.leverage.rawUsd.
      // To match the dashboard's "Total USDC" we add: cross account value +
      // sum of every isolated position's rawUsd (their dedicated collateral).
      const crossAcctValue = parseFloat(
        mainCs.crossMarginSummary?.accountValue
        ?? mainCs.marginSummary?.accountValue
        ?? 0
      );
      const withdraw = parseFloat(mainCs.withdrawable || 0);
      let isolatedUsdSum = 0;

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
          const isIsolated = pos.leverage?.type === "isolated";
          const levType = isIsolated ? "ISO" : "CROSS";
          const levVal  = pos.leverage?.value;
          const levTag  = levVal ? `${levVal}x ${levType}` : levType;
          unrealPnlTotal += uPnl;
          perpPositionNotionalTotal += notional;
          // Isolated position has its own USDC pool — add it to the perp total.
          if (isIsolated) {
            const isoRaw = parseFloat(pos.leverage?.rawUsd || pos.marginUsed || 0);
            // Effective USDC value of this isolated pool = rawUsd + unrealized PnL.
            isolatedUsdSum += isoRaw + uPnl;
          }
          posLines += `  📍 <code>${pos.coin}</code> ${side} ${Math.abs(szi)} @ $${mark.toFixed(4)} | Value: $${notional.toFixed(2)} | ${levTag} | uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(4)}\n`;
        }
      }

      perpTotal = crossAcctValue + isolatedUsdSum;
      perpFree  = withdraw;
      console.log(`[HL portfolio] perpTotal=$${perpTotal.toFixed(2)} (cross $${crossAcctValue.toFixed(2)} + iso $${isolatedUsdSum.toFixed(2)})`);
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

    // Save main-account perp values before adding HIP-3 dex balances.
    const perpMainTotal = perpTotal;
    const perpMainFree  = perpFree;

    // ── HIP-3 perp dexs (e.g. SPCX, BLST, "xyz") ──
    // Hyperliquid lets third parties deploy their own perp DEXs on top of
    // HL. Each has its OWN clearinghouse + USDC pool, separate from the
    // base perp clearinghouse we queried above. The dashboard tags
    // balances with [<dex_name>]. We enumerate all perp dexs and query
    // user state for each so isolated balances + positions are included.
    let dexList = [];
    try {
      const r = await hlPost({ type: "perpDexs" });
      console.log(`[HL probe:perpDexs] HTTP ${r.status} — body: ${JSON.stringify(r.body).slice(0, 600)}`);
      // Response is an array; entries with null = base, named entries = HIP-3 dexs.
      if (Array.isArray(r.body)) {
        for (const entry of r.body) {
          if (!entry) continue; // skip the null = base entry
          const name = entry.name || entry.fullName || null;
          if (name) dexList.push(name);
        }
      }
    } catch (e) { console.warn("[HL perpDexs] failed:", e.message); }

    const dexAcctEntries = []; // { name, total, free } — one per non-empty HIP-3 dex
    for (const dex of dexList) {
      try {
        const r = await hlPost({ type: "clearinghouseState", user: walletAddr, dex });
        if (!r.ok || !r.body || typeof r.body !== "object") continue;
        const cs = r.body;
        const dexAcct = parseFloat(cs.marginSummary?.accountValue || 0);
        const dexFree = parseFloat(cs.withdrawable || 0);
        // Skip empty dexes silently (there are dozens) — only keep funded ones.
        if (dexAcct === 0 && (!cs.assetPositions || cs.assetPositions.length === 0)) continue;
        dexAcctEntries.push({ name: dex, total: dexAcct, free: dexFree });
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
            const levType = pos.leverage?.type === "isolated" ? "ISO" : "CROSS";
            const levVal  = pos.leverage?.value;
            const levTag  = levVal ? `${levVal}x ${levType}` : levType;
            unrealPnlTotal += uPnl;
            perpPositionNotionalTotal += notional;
            posLines += `  📍 [<code>${dex}</code>] <code>${pos.coin}</code> ${side} ${Math.abs(szi)} @ $${mark.toFixed(4)} | Value: $${notional.toFixed(2)} | ${levTag} | uPnL: ${uPnl>=0?"+":""}$${uPnl.toFixed(4)}\n`;
          }
        }
      } catch (e) {
        console.warn(`[HL dex:${dex}] fetch failed:`, e.message);
      }
    }

    for (const d of dexAcctEntries) { perpTotal += d.total; perpFree += d.free; }

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

    // ── COMBINED — actual wallet value (USDT-equivalent) ──
    // Perp USDC (cross + isolated, includes uPnL) + spot tokens.
    // Position notional is leveraged exposure, NOT money — shown
    // separately below for visibility but excluded from the total.
    const combinedUsd = perpTotal + spotUsdTotal;

    const envTag = useTestnet ? "🧪 TESTNET" : "🟢 MAINNET";
    const unknownNote = spotUnknownTokens.length > 0
      ? `\n<i>⚠ No price for: ${spotUnknownTokens.join(", ")} — not in total</i>`
      : "";
    const exposureLine = perpPositionNotionalTotal > 0
      ? `\n<i>📈 Open position exposure (notional, not in total): $${perpPositionNotionalTotal.toFixed(2)}</i>`
      : "";

    // Per-account perp breakdown: main HL + each non-empty HIP-3 dex
    let perpAcctLines = `  USDC (Perps):  <b>$${perpMainTotal.toFixed(2)}</b> <i>(free: $${perpMainFree.toFixed(2)})</i>\n`;
    for (const d of dexAcctEntries) {
      perpAcctLines += `  USDC (${d.name}):    <b>$${d.total.toFixed(2)}</b> <i>(free: $${d.free.toFixed(2)})</i>\n`;
    }

    return `<b>💼 🟣 Hyperliquid Portfolio</b> ${envTag}
<i>${new Date().toLocaleString()}</i>
Wallet: <code>${walletAddr.slice(0,10)}...${walletAddr.slice(-6)}</code>

━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>Perps Accounts</b>
${perpAcctLines}  Perps total:  <b>$${perpTotal.toFixed(2)}</b>
  Unrealized PnL: <b>${unrealPnlTotal>=0?"+":""}$${unrealPnlTotal.toFixed(2)}</b>

━━━━━━━━━━━━━━━━━━━━━━━━━
🪙 <b>Spot Account</b> (all tokens valued in USDC)
${spotLines}  Spot total: <b>$${spotUsdTotal.toFixed(2)}</b>${unknownNote}

━━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Open Perp Positions</b>
${posLines}
━━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>TOTAL ≈ $${combinedUsd.toFixed(2)} USDT</b>
   Perps:  $${perpTotal.toFixed(2)}
   Spot:   $${spotUsdTotal.toFixed(2)}${exposureLine}`;

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
async function tgDoRestart(chatId, botId, sellSpread, buySpread, targetSpread, qty, distance, priceSource, symbol) {
  const bot = bots[botId];
  const exchangeKey = bot?.exchangeKey || botId;   // exchange family (env keys, tag)
  const tag = EXCHANGE_TAG[exchangeKey];
  const prev = bot?.config;

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
    try{ await cancelAllOrders(botId); } catch(e){}
    log(botId, "Telegram restart: stopped previous session", "warn");
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
  await applyAccountCreds(cfg);   // override with the selected account's keys, if any

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

    // Pre-warm Hyperliquid native SDK before ticker fetch (HIP-3 aware; shared
    // with /api/start and gridLoop self-heal).
    if (exchangeKey === "hyperliquid") {
      await ensureHlCache(botId, bot, cfg, exchange);
    }

    const tick       = await getTickerSnapshot(exchange, cfg.symbol, 15000, bot);
    const entryPrice = tick.last;
    const upperLimit = parseFloat((entryPrice + cfg.distance).toFixed(8));
    const lowerLimit = parseFloat((entryPrice - cfg.distance).toFixed(8));

    Object.assign(bot, {
      botId, exchangeKey,
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

    await maintainGrid(botId, entryPrice);
    const runningCount = listBots().filter(b => b.running).length;
    const loopMs = runningCount <= 1 ? 4000 : runningCount === 2 ? 5000 : runningCount === 3 ? 7000 : 9000;
    bot.loopTimer = setInterval(() => gridLoop(botId), loopMs);
    log(botId, `Telegram ${prev ? "restart" : "launch"}: RUNNING | Entry $${entryPrice} | ${cfg.symbol}`, "success");
    broadcast("state", buildStateSnapshot());

    await tgSend(chatId,
      `✅ <b>${tag} ${prev ? "Restarted" : "Launched"}!</b>\n\n` +
      `Symbol: <code>${cfg.symbol}</code>\n` +
      `Entry : <code>$${entryPrice.toFixed(4)}</code>\n` +
      `Upper : <code>$${upperLimit.toFixed(4)}</code>\n` +
      `Lower : <code>$${lowerLimit.toFixed(4)}</code>\n` +
      `Log   : <code>logs/${botId}.log</code>`,
      mainMenu()
    );
  } catch(err) {
    log(botId, `Telegram ${prev ? "restart" : "launch"} failed: ${err.message}`, "error");
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
      await tgEdit(fromId, msgId, panelStatusText(), mainMenu());
      return;
    }
    if (data.startsWith("act_")) {
      const action = data.slice(4);
      if (action === "help") { await tgEdit(fromId, msgId, tgHelpText(), mainMenu()); return; }
      await tgEdit(fromId, msgId, `Pick an exchange for <b>${action.toUpperCase()}</b>:`, exchangeSelectorMenu(action));
      return;
    }
    // Per-bot action: "bot:<botId>:<action>" (":" delimited because dynamic
    // botIds like "hyperliquid_2" contain underscores).
    if (data.startsWith("bot:")) {
      const idx1 = data.indexOf(":");
      const idx2 = data.lastIndexOf(":");
      const botId  = data.slice(idx1 + 1, idx2);
      const action = data.slice(idx2 + 1);
      await runBotAction(fromId, msgId, botId, action);
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
      // Restart targets a specific bot instance (conv.botId), so two coins on
      // one exchange each restart with their own saved config. Falls back to
      // the legacy slot for a fresh launch.
      const targetId = conv.botId || conv.exchangeKey;
      const exch = bots[targetId]?.exchangeKey || conv.exchangeKey || targetId;
      const prev = bots[targetId]?.config;
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
        await tgDoRestart(fromId, targetId, ss, bs, ts, q, dist);
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
        await tgDoRestart(fromId, targetId, ss, bs, ts, q, dist, priceSource, symbol);
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
        await tgSend(fromId, panelStatusText(), mainMenu()); break;
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
    case "status": {
      // Multiple bots on this exchange (e.g. SPCX + HYPE on Hyperliquid) →
      // let the user pick which one. One bot → show it directly.
      const list = botsForExchange(exchangeKey).filter(b => b.running);
      if (list.length > 1) {
        await tgEdit(chatId, msgId, `${tag} — pick a bot:`, botSelectorMenu(exchangeKey, "status", list));
        return;
      }
      const targetId = list[0]?.botId || exchangeKey;
      await tgEdit(chatId, msgId, tgStatusText(targetId), botMenu(targetId));
      return;
    }
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
    case "stop": {
      // If several bots run on this exchange, pick which one to stop.
      const list = botsForExchange(exchangeKey).filter(b => b.running);
      if (list.length > 1) {
        await tgEdit(chatId, msgId, `${tag} — pick a bot to stop:`, botSelectorMenu(exchangeKey, "stop", list));
        return;
      }
      const targetId = list[0]?.botId || exchangeKey;
      await stopBotById(chatId, msgId, targetId);
      return;
    }
    case "restart": {
      // Candidates = every bot on this exchange that has a saved config
      // (running OR stopped). If more than one, let the user pick which coin
      // to restart so it shows that bot's own previous inputs.
      const candidates = botsForExchange(exchangeKey).filter(b => b.config);
      if (candidates.length > 1) {
        await tgEdit(chatId, msgId, `${tag} — pick a bot to restart:`, botSelectorMenu(exchangeKey, "restart", candidates));
        return;
      }
      const targetId = candidates[0]?.botId || exchangeKey;
      const tbot = bots[targetId];
      tgConv[chatId] = { step: "awaiting_params", botId: targetId };
      await tgEdit(chatId, msgId, restartPromptText(tbot?.exchangeKey || exchangeKey, tbot?.config),
        [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
      return;
    }
    default:
      await tgEdit(chatId, msgId, "Unknown action.", mainMenu());
  }
}

// Stop one specific bot instance (by botId, not exchange family).
async function stopBotById(chatId, msgId, botId) {
  const bot = bots[botId];
  if (!bot) { await tgEdit(chatId, msgId, "Bot not found (it may have stopped).", mainMenu()); return; }
  const tag  = EXCHANGE_TAG[bot.exchangeKey] || bot.exchangeKey;
  const coin = coinShort(bot.config?.symbol);
  if (!bot.running) {
    await tgEdit(chatId, msgId, `ℹ️ ${tag} ${coin} is already stopped.`, mainMenu());
    return;
  }
  clearInterval(bot.loopTimer); bot.running = false;
  try { await cancelAllOrders(botId); } catch (e) {}
  db.clearSession(botId);
  log(botId, "Telegram stop", "warn");
  broadcast("state", buildStateSnapshot());
  await tgEdit(chatId, msgId,
    `🛑 <b>${tag} ${coin} Stopped</b>\n\nSymbol: <code>${bot.config?.symbol||"—"}</code>\nLast Price: <code>$${bot.lastPrice||"—"}</code>\nTime: ${new Date().toLocaleString()}`,
    mainMenu());
}

// Per-bot action from the bot selector ("bot:<botId>:<action>").
async function runBotAction(chatId, msgId, botId, action) {
  const bot = bots[botId];
  if (!bot) { await tgEdit(chatId, msgId, "Bot not found (it may have stopped).", mainMenu()); return; }
  switch (action) {
    case "status":
      await tgEdit(chatId, msgId, tgStatusText(botId), botMenu(botId));
      return;
    case "stop":
      await stopBotById(chatId, msgId, botId);
      return;
    case "restart":
      // Restart THIS bot — show its own previous inputs, then await params.
      tgConv[chatId] = { step: "awaiting_params", botId };
      await tgEdit(chatId, msgId, restartPromptText(bot.exchangeKey, bot.config),
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
  // Per-bot log file (so `tail -f logs/<botId>.log` shows only this bot).
  // Size-capped with rotation so it can't fill the disk over long sessions.
  try {
    const line = `${ts}  [${level.toUpperCase().padEnd(7)}] ${msg}\n`;
    getLogStream(botId);            // ensure stream + byte count initialized
    rotateLogIfNeeded(botId);       // rotate if the current file is over the cap
    getLogStream(botId).write(line);
    logBytes[botId] = (logBytes[botId] || 0) + Buffer.byteLength(line);
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
      console.log("[HYPERLIQUID HIP-3] 🟣 HIP-3 perp dex mode — orders route via the native SDK with the dex-encoded asset id.");
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

// If cfg.accountId points to a saved account, override the credentials with
// that account's keys so the bot trades on THAT account. Call after
// injectKeysIntoCfg. HL keeps creds in the apiKey(=walletAddress) /
// secretKey(=privateKey) slots, matching buildExchange + ensureHlCache.
async function applyAccountCreds(cfg) {
  if (!cfg.accountId) return false;
  let acc;
  try { acc = await db.getAccount(parseInt(cfg.accountId, 10)); } catch (e) { acc = null; }
  if (!acc) return false;
  const c = acc.credentials || {};
  if (acc.exchange === "hyperliquid")   { cfg.apiKey = c.walletAddress; cfg.secretKey = c.privateKey; }
  else if (acc.exchange === "binance")  { cfg.apiKey = c.apiKey;        cfg.secretKey = c.secretKey; }
  else if (acc.exchange === "deribit")  { cfg.apiKey = c.clientId;      cfg.secretKey = c.clientSecret; }
  cfg.accountName = acc.name;
  return true;
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
  const l2Args = { coin: cache.coinId };
  if (cache.hipDex) l2Args.dex = cache.hipDex;
  const book = await Promise.race([
    cache.infoClient.l2Book(l2Args),
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
  // Hyperliquid ALWAYS uses the native SDK (CCXT's fetchTicker is broken for
  // HL, and HIP-3 symbols aren't in CCXT's market list at all). Never fall
  // back to CCXT here — if the cache isn't ready, raise a clear error instead
  // of CCXT's misleading "does not have market symbol".
  if (bot && bot.exchangeKey === "hyperliquid") {
    if (!bot.hlCache) throw new Error("Hyperliquid SDK cache not ready");
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

async function getMarketInfo(exchange, symbol, bot = null) {
  // For Hyperliquid (all variants incl. HIP-3): skip CCXT market lookup.
  // HIP-3 symbols like xyz:SPCX/USDC:USDC are not in CCXT's HL market list.
  // Precision comes from the SDK meta prewarm stored in bot.hlCache.
  if (bot?.hlCache) {
    const szDec    = bot.hlCache.szDecimals ?? 4;
    const stepSize = parseFloat(Math.pow(10, -szDec).toFixed(szDec));
    // HL uses 5 sig figs for prices. For assets ~$10-$9999 this is 0.001;
    // for sub-dollar assets 0.0001. Use szDec as a rough proxy.
    const tickSize = szDec >= 4 ? 0.0001 : 0.001;
    return { tickSize, stepSize, market: {} };
  }
  // CCXT path (Binance/Deribit, or HL without a warmed cache). HIP-3 symbols
  // (e.g. xyz:SPCX/USDC:USDC) are NOT in CCXT's Hyperliquid market list, so
  // exchange.market() throws for them. Never let that crash the grid loop —
  // fall back to safe defaults so fill handling / round trips keep working.
  try {
    await exchange.loadMarkets();
    const market   = exchange.market(symbol);
    const tickSize = market.precision?.price  || 0.01;
    const stepSize = market.precision?.amount || 0.001;
    return { tickSize, stepSize, market };
  } catch (e) {
    return { tickSize: 0.001, stepSize: 0.001, market: {} };
  }
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
// Build (or rebuild) the Hyperliquid native-SDK cache on a bot. Idempotent —
// safe to call again if a prior prewarm failed (e.g. a transient network error
// at start), so a bot is never left permanently without hlCache (which would
// make it fall back to CCXT — broken for HL — on every tick). Returns true on
// success. Pass `exchange` to also (re)bind bot.exchange; omit on self-heal.
async function ensureHlCache(botId, bot, cfg, exchange = null) {
  try {
    const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
    // Per-account creds live in cfg (apiKey=walletAddress, secretKey=privateKey);
    // fall back to .env for the default account.
    const privKey       = cfg.secretKey || process.env.HYPERLIQUID_PRIVATE_KEY;
    const walletAddress = cfg.apiKey    || process.env.HYPERLIQUID_WALLET_ADDRESS;
    const wallet     = privateKeyToAccount(privKey);
    const transport  = new hl.HttpTransport({ isTestnet: useTestnet });
    const exchClient = new hl.ExchangeClient({ wallet, transport, isTestnet: useTestnet });
    const infoClient = new hl.InfoClient({ transport });

    const isSpot = (cfg.priceSource === "hyperliquid_spot");
    const isHip3 = (cfg.priceSource === "hyperliquid_hip3");
    const hipDex = isHip3 ? (cfg.hipDex || "xyz") : null;
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
    } else if (isHip3) {
      // HIP-3 (builder-deployed) perp dex. The dex is encoded into the asset
      // id: assetId = 100000 + perpDexIndex*10000 + localIndex (no "dex" field
      // on the order action). See SymbolConverter._processBuilderDexResult.
      const hlHost = useTestnet ? "api.hyperliquid-testnet.xyz" : "api.hyperliquid.xyz";
      const mr = await fetch(`https://${hlHost}/info`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta", dex: hipDex }),
      });
      if (!mr.ok) throw new Error(`HIP-3 meta fetch failed: HTTP ${mr.status}`);
      const m = await mr.json();
      const allAssets  = m.universe || [];
      const dexPrefix  = hipDex + ":";
      const dexOnly    = allAssets.filter(u => u.name?.startsWith(dexPrefix));
      const searchList = dexOnly.length > 0 ? dexOnly : allAssets;
      const baseSuffix = base.includes(":") ? base.split(":").slice(1).join(":") : base;
      let localIndex = -1;
      for (let i = 0; i < searchList.length; i++) {
        const nm = searchList[i].name || "";
        if (nm === base || nm === baseSuffix || nm === dexPrefix + baseSuffix) {
          localIndex = i;
          szDecimals = searchList[i].szDecimals ?? 4;
          maxSig = 5;
          coinId = nm.startsWith(dexPrefix) ? nm : dexPrefix + nm;
          break;
        }
      }
      let perpDexIndex = -1;
      const pdr = await fetch(`https://${hlHost}/info`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "perpDexs" }),
      });
      if (pdr.ok) {
        const pds = await pdr.json();
        if (Array.isArray(pds)) {
          for (let k = 0; k < pds.length; k++) {
            if (pds[k]?.name === hipDex) { perpDexIndex = k; break; }
          }
        }
      }
      if (localIndex >= 0 && perpDexIndex >= 0) {
        assetIndex = 100000 + perpDexIndex * 10000 + localIndex;
      }
      log(botId, `[HIP-3 meta] localIdx=${localIndex} perpDexIdx=${perpDexIndex} assetId=${assetIndex} coin=${coinId} szDec=${szDecimals}`, "info");
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
    bot.hlCache = { exchClient, infoClient, assetIndex, base, coinId, szDecimals, maxSig, isSpot, hipDex, walletAddress };
    if (exchange) bot.exchange = exchange;  // also needed for non-HL paths
    log(botId, `Hyperliquid SDK pre-warmed: ${base} idx=${assetIndex} coin=${coinId} szDec=${szDecimals} sig=${maxSig}${isSpot ? " [SPOT]" : " [PERP]"}`, "info");
    return true;
  } catch (e) {
    log(botId, `Hyperliquid SDK pre-warm failed: ${e.message}`, "warn");
    return false;
  }
}

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
    // Self-heal: if a Hyperliquid bot is running without its native cache (a
    // transient prewarm failure at start), rebuild it now. Without this the
    // bot would fall back to CCXT — broken for HL, and HIP-3 symbols aren't
    // even in CCXT's market list — and spam "does not have market symbol"
    // errors every tick while never trading.
    if (exchangeKey === "hyperliquid" && !bot.hlCache) {
      const ok = await ensureHlCache(botId, bot, bot.config);
      if (!ok) { return; }   // still not ready — retry next tick (finally clears the lock)
    }

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

    // Persist in-memory state every 30s so a deploy/reboot can resume in
    // place without cancelling orders or recomputing the grid. (30s not 10s
    // keeps MySQL binlog churn — a full-disk risk on small volumes — low;
    // openOrders are reconciled against the exchange on resume anyway.)
    if (!bot._lastStateSave || Date.now() - bot._lastStateSave > 30000) {
      bot._lastStateSave = Date.now();
      db.saveSessionState(botId, {
        openOrders         : bot.openOrders,
        pendingRoundTrips  : bot.pendingRoundTrips,
        completedRoundTrips: bot.completedRoundTrips.slice(0, 200),
        fillHistory        : bot.fillHistory.slice(0, 100),
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
// Records a fill and does whatever it implies (open a pending round trip
// for an entry fill, or close one out for a target fill). This is the
// SINGLE place a fill gets processed, called both from the normal poll
// below (checkAndHandleFills) AND from every place a cancel attempt can
// discover "oh, this order actually already filled" — placeTargetOrder's
// victim eviction, maintainGrid's far-order cleanup (both exchanges), and
// syncOrdersFromExchange's orphan cleanup. Before this existed, those
// cancel-race paths either silently dropped the fill (Hyperliquid) or
// just left it stuck as "cancel failed, retry next loop" for an extra
// ~9s tick until the normal poll eventually caught it on its own (CCXT) —
// this makes recognition immediate and guarantees it's never dropped
// regardless of which code path discovers the fill first.
//
// `order` is the CCXT fetchOrder() result when available (Binance/
// Deribit) — used for the exact fill price/qty/fee. Omitted for
// Hyperliquid (no cheap equivalent lookup), which falls back to the
// tracked order's own resting price/qty — the same assumption the
// pre-existing Hyperliquid fill path already made, since its orders are
// always post-only limit orders that fill exactly at their resting price.
async function processFilledOrder(botId, tracked, order) {
  const bot = bots[botId];
  if (!bot) return;
  const exchangeKey = bot.exchangeKey;
  const cfg = bot.config;

  const fillTs    = new Date().toISOString();
  const fillPrice = order ? parseFloat(order.average || order.price || tracked.price) : tracked.price;
  const fillQty   = order ? parseFloat(order.filled  || order.amount || tracked.qty)   : tracked.qty;

  // Hyperliquid never returns a real fee — always an estimate (maker rate,
  // since orders are always post-only). CCXT exchanges (Binance/Deribit)
  // report a real fee when available, defaulting to 0 — not an estimate —
  // when they don't (e.g. Binance futures often omits it on fetchOrder).
  // This matches each exchange's pre-extraction behavior exactly.
  const feeKnown = order ? (order.fee != null && order.fee.cost != null) : false;
  const feeCost  = order ? parseFloat(order.fee?.cost ?? 0) : estimateFee(cfg.priceSource, fillPrice, fillQty);
  const feeCcy   = order?.fee?.currency || "USDC";

  if (order) {
    log(botId, `FILLED [${tracked.type.toUpperCase()}] ${tracked.side.toUpperCase()} @ $${fillPrice}  qty:${fillQty}  fee:${feeKnown ? "$" + feeCost.toFixed(4) : "n/a"}`, "success");
  } else {
    log(botId, `FILLED [${tracked.type.toUpperCase()}] ${tracked.side.toUpperCase()} @ $${fillPrice}  qty:${fillQty}  fee≈$${feeCost.toFixed(4)}`, "success");
  }

  const fillRecord = {
    side: tracked.side, price: fillPrice, qty: fillQty,
    type: tracked.type, ts: fillTs,
    fee: feeCost, feeCcy, orderId: tracked.id,
  };
  bot.fillHistory.unshift(fillRecord);
  db.recordFill(bot, fillRecord);

  if (tracked.type === "entry") {
    const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol, bot);
    const targetSide  = tracked.side === "sell" ? "buy" : "sell";
    const targetPrice = tracked.side === "sell"
      ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
      : roundPrice(fillPrice + cfg.targetSpread, tickSize);

    bot.pendingRoundTrips.push({
      id: `rt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      openSide: tracked.side, openPrice: fillPrice,
      targetOrderId: null, targetSide, targetPrice,
      qty: fillQty, openTs: fillTs,
      openOrderId: tracked.id,
      openFee: feeKnown ? feeCost : null,
    });
    log(botId, `📌 Pending RT: ${tracked.side.toUpperCase()} @ $${fillPrice} → target ${targetSide.toUpperCase()} @ $${targetPrice} (${bot.pendingRoundTrips.length} pending)`);
    return;
  }

  if (tracked.type === "target") {
    const matched = bot.pendingRoundTrips.filter(rt => rt.targetOrderId === tracked.id);
    if (matched.length === 0) {
      const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol, bot);
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

    bot.pendingRoundTrips = bot.pendingRoundTrips.filter(rt => !matched.includes(rt));

    for (const rt of matched) {
      const buyPrice  = rt.openSide === "buy"  ? rt.openPrice : fillPrice;
      const sellPrice = rt.openSide === "sell" ? rt.openPrice : fillPrice;
      const grossPnl  = parseFloat(((sellPrice - buyPrice) * rt.qty).toFixed(8));

      let openFee, closeFee;
      if (exchangeKey === "hyperliquid") {
        openFee  = estimateFee(cfg.priceSource, rt.openPrice, rt.qty);
        closeFee = estimateFee(cfg.priceSource, fillPrice, rt.qty);
      } else {
        // Take ACTUAL exchange fees for both legs (incl. 0 — e.g. a 0-maker
        // promo). fetchOrder omits the fee on some exchanges (Binance
        // futures), so if either leg's fee is unknown, pull it from the
        // trade history (one call, matched by order id). Estimate only when
        // the exchange still gives us nothing.
        let realOpen  = rt.openFee;
        let realClose = feeKnown ? feeCost : null;
        if (realOpen == null || realClose == null) {
          try {
            const trades = await bot.exchange.fetchMyTrades(cfg.symbol, undefined, 100);
            const byOid = {};
            for (const t of trades) {
              const oid = String(t.order ?? t.info?.orderId ?? t.info?.order_id ?? "");
              if (oid) byOid[oid] = (byOid[oid] || 0) + parseFloat(t.fee?.cost ?? 0);
            }
            if (realOpen  == null && byOid[String(rt.openOrderId)] !== undefined) realOpen  = byOid[String(rt.openOrderId)];
            if (realClose == null && byOid[String(tracked.id)]     !== undefined) realClose = byOid[String(tracked.id)];
          } catch (e) { log(botId, `Fee lookup failed, estimating: ${e.message}`, "warn"); }
        }
        openFee  = realOpen  != null ? realOpen  : estimateFee(cfg.priceSource, rt.openPrice, rt.qty);
        closeFee = realClose != null ? realClose : estimateFee(cfg.priceSource, fillPrice, rt.qty);
      }
      const totalFee = parseFloat((openFee + closeFee).toFixed(8));
      const netPnl   = parseFloat((grossPnl - totalFee).toFixed(8));

      const rtRecord = {
        id: rt.id, openSide: rt.openSide,
        openPrice: rt.openPrice, closePrice: fillPrice,
        buyPrice, sellPrice, qty: rt.qty,
        pnl: grossPnl,
        grossPnl, totalFee, netPnl,
        openTs: rt.openTs, closeTs: fillTs,
        durationMs: Date.now() - new Date(rt.openTs).getTime(),
      };
      bot.completedRoundTrips.unshift(rtRecord);
      db.recordRoundTrip(bot, rtRecord, bot.completedRoundTrips.length);
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
    const wallet = cache.walletAddress || process.env.HYPERLIQUID_WALLET_ADDRESS;
    let exchangeOrders;
    try {
      const openOrdersArgs = { user: wallet };
      if (cache.hipDex) openOrdersArgs.dex = cache.hipDex;
      exchangeOrders = await Promise.race([
        cache.infoClient.openOrders(openOrdersArgs),
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
      await processFilledOrder(botId, tracked);
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
        await processFilledOrder(botId, tracked, order);
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
  const { tickSize, stepSize } = await getMarketInfo(bot.exchange, cfg.symbol, bot);

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
      const result = await cancelSingleOrder(botId, victim.id, cfg.symbol);
      if (result.status === "cancelled") {
        bot.recentlyCancelled = bot.recentlyCancelled || {};
        bot.recentlyCancelled[victim.id] = Date.now();
        bot.openOrders = bot.openOrders.filter(o => o.id !== victim.id);
        log(botId, `Removed ENTRY ${victim.side.toUpperCase()} @ $${victim.price} — making room for target`);
      } else if (result.status === "filled") {
        // It filled instead of cancelling — process it as a real fill
        // (opens its own pending round trip) rather than losing it.
        bot.openOrders = bot.openOrders.filter(o => o.id !== victim.id);
        await processFilledOrder(botId, victim, result.order);
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
  const { tickSize, stepSize } = await getMarketInfo(bot.exchange, cfg.symbol, bot);
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
  // Spacing is a distance and must be positive — a negative value here would
  // flip buy prices above the anchor (and sell prices below it), so every
  // computed order guarantees a spread cross and gets rejected forever
  // (root cause of the HYPE bots showing zero open orders despite running).
  const bandSpacingSell = Math.abs(cfg.avgSellSpacing);
  const bandSpacingBuy  = Math.abs(cfg.avgBuySpacing);
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
  const sSpace = Math.abs(cfg.avgSellSpacing);
  const bSpace = Math.abs(cfg.avgBuySpacing);
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
          const cancelled = (s === "success") || (s && s.error && /never placed|already cancel/i.test(s.error));
          // "filled" specifically means it executed, not that it's gone —
          // process it as a real fill instead of silently dropping it.
          const filled = s && s.error && /filled/i.test(s.error) && !cancelled;
          if (cancelled) {
            bot.recentlyCancelled = bot.recentlyCancelled || {};
            bot.recentlyCancelled[o.id] = Date.now();
            bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
            if (o.type === "target") {
              for (const rt of bot.pendingRoundTrips) {
                if (rt.targetOrderId === o.id) rt.targetOrderId = null;
              }
            }
            log(botId, `↓ Cancelled ${o.type?.toUpperCase()||""} ${o.side.toUpperCase()} @ $${o.price} — far from price`);
          } else if (filled) {
            bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
            await processFilledOrder(botId, o);
          }
        }
      } else {
        log(botId, `Batch cancel failed: ${result.error} — will retry next loop`, "warn");
      }
    } else {
      // CCXT path (Binance/Deribit): serial is fine, those APIs are fast
      for (const o of toCancel) {
        if (!bot.running) break;
        const result = await cancelSingleOrder(botId, o.id, cfg.symbol);
        if (result.status === "cancelled") {
          bot.recentlyCancelled = bot.recentlyCancelled || {};
          bot.recentlyCancelled[o.id] = Date.now();
          bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
          if (o.type === "target") {
            for (const rt of bot.pendingRoundTrips) {
              if (rt.targetOrderId === o.id) rt.targetOrderId = null;
            }
          }
          log(botId, `↓ Cancelled ${o.type?.toUpperCase()||""} ${o.side.toUpperCase()} @ $${o.price} — far from price`);
        } else if (result.status === "filled") {
          bot.openOrders = bot.openOrders.filter(x => x.id !== o.id);
          await processFilledOrder(botId, o, result.order);
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
  const wallet = cache.walletAddress || process.env.HYPERLIQUID_WALLET_ADDRESS;
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

  const parseStatuses = (statuses, n) =>
    Array.from({ length: n }, (_, i) => {
      const s = statuses?.[i];
      if (s?.resting) return { id: String(s.resting.oid), error: null };
      if (s?.filled)  return { id: String(s.filled.oid),  error: null, filled: true };
      if (s?.error)   return { id: null, error: s.error };
      return { id: null, error: "unknown status" };
    });

  try {
    // For HIP-3, cache.assetIndex is the encoded builder asset id
    // (100000 + perpDexIndex*10000 + localIndex). The Exchange API routes by
    // that id alone — no "dex" field on the action — so the standard SDK call works.
    const resp = await Promise.race([
      cache.exchClient.order({ orders: orderRequests, grouping: "na" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Native order timeout 10s")), 10000)),
    ]);
    const statuses = resp?.response?.data?.statuses;
    return parseStatuses(statuses, orders.length);
  } catch (e) {
    // Parse partial-success from error.response (same pattern as cancel)
    const statuses = e?.response?.response?.data?.statuses;
    if (Array.isArray(statuses) && statuses.length === orders.length) {
      return parseStatuses(statuses, orders.length);
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
// CCXT for others.
// Returns { status: "cancelled" | "filled" | "failed", order? }. Callers
// MUST branch on status — "filled" means the order actually executed and
// needs processFilledOrder(), not "cancelled" bookkeeping. Before this
// fix, a cancel attempt that raced against a genuine fill was indistinct
// from a clean cancel (or from a real failure), which is exactly how a
// fill could get silently dropped: this bot never saw it, never opened a
// pending round trip or a closing target for it, yet the exchange had
// already executed it.
async function cancelSingleOrder(botId, orderId, symbol) {
  const bot = bots[botId];
  const exchangeKey = bot.exchangeKey;
  if (exchangeKey === "hyperliquid") {
    const result = await hyperliquidNativeCancel(bot, [orderId]);
    if (!result.ok) return { status: "failed" };
    const s = result.results[0]?.status;
    if (s === "success") return { status: "cancelled" };
    if (s && s.error) {
      const m = s.error.toLowerCase();
      // "filled" specifically means the order already executed — that's a
      // fill to process, not a cancellation. Only "never placed"/"already
      // cancelled" genuinely mean it's gone with nothing to record.
      if (m.includes("filled")) return { status: "filled" };
      if (m.includes("never placed") || m.includes("already cancel")) return { status: "cancelled" };
    }
    return { status: "failed" };
  }
  // CCXT path for Binance/Deribit, with timeout safety
  try {
    await Promise.race([
      bot.exchange.cancelOrder(orderId, symbol),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 5s")), 5000)),
    ]);
    return { status: "cancelled" };
  } catch (err) {
    const m = (err.message || "").toLowerCase();
    if (m.includes("never placed") || m.includes("already cancel")) return { status: "cancelled" };
    // Ambiguous failure (Binance's actual wording for "already filled" is
    // typically "Unknown order sent.", which doesn't literally say
    // "filled") — ask the exchange directly instead of guessing from error
    // text, which is exactly what silently dropped fills before this fix.
    try {
      const order = await bot.exchange.fetchOrder(orderId, symbol);
      const os = String(order?.status || "").toLowerCase();
      if (os === "closed" || os === "filled") return { status: "filled", order };
      if (["canceled", "cancelled", "expired", "rejected"].includes(os)) return { status: "cancelled" };
    } catch (e2) { /* fetchOrder itself failed too — genuinely can't tell, retry next loop */ }
    return { status: "failed" };
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
    // Fresh lookup (slow path) — use the bot's per-account key if present.
    const useTestnet = String(process.env.HYPERLIQUID_TESTNET || "").toLowerCase() === "true";
    const wallet = privateKeyToAccount(bot.config?.secretKey || process.env.HYPERLIQUID_PRIVATE_KEY);
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
      } else if (cfg.priceSource === "hyperliquid_hip3") {
        // Encode the builder asset id: 100000 + perpDexIndex*10000 + localIndex.
        const hipDex = cfg.hipDex || "xyz";
        const hlHost = useTestnet ? "api.hyperliquid-testnet.xyz" : "api.hyperliquid.xyz";
        const mr = await fetch(`https://${hlHost}/info`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "meta", dex: hipDex }),
        });
        const m = await mr.json();
        const allA = m.universe || [];
        const dexPfx = hipDex + ":";
        const dexA   = allA.filter(u => u.name?.startsWith(dexPfx));
        const srcA   = dexA.length > 0 ? dexA : allA;
        const sfx    = base.includes(":") ? base.split(":").slice(1).join(":") : base;
        let localIndex = -1;
        for (let i = 0; i < srcA.length; i++) {
          const nm = srcA[i].name || "";
          if (nm === base || nm === sfx || nm === dexPfx + sfx) { localIndex = i; break; }
        }
        let perpDexIndex = -1;
        const pdr = await fetch(`https://${hlHost}/info`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "perpDexs" }),
        });
        if (pdr.ok) {
          const pds = await pdr.json();
          if (Array.isArray(pds)) {
            for (let k = 0; k < pds.length; k++) {
              if (pds[k]?.name === hipDex) { perpDexIndex = k; break; }
            }
          }
        }
        if (localIndex >= 0 && perpDexIndex >= 0) assetIndex = 100000 + perpDexIndex * 10000 + localIndex;
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
    // assetIndex is the encoded HIP-3 builder asset id when applicable; the
    // Exchange API routes cancels by that id alone (no "dex" field on the action).
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
          const m = status.error.toLowerCase();
          if (m.includes("filled")) {
            // It filled instead of cancelling — the bot is stopping (and
            // discards pendingRoundTrips right after this loop regardless),
            // but the resulting position is real and now unmanaged. Warn
            // clearly instead of folding it into "already gone" — silence
            // here is exactly how a stopped bot leaves an unexpected open
            // position nobody notices.
            log(botId, `  ↳ ⚠️ ${tag} FILLED instead of cancelling — you now have an open position from this order, it will not be tracked after stop`, "warn");
            ok++;
          } else if (m.includes("never placed") || m.includes("already cancel")) {
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
    const wallet = cache.walletAddress || process.env.HYPERLIQUID_WALLET_ADDRESS;
    let exchangeOrders;
    try {
      const orphanArgs = { user: wallet };
      if (cache.hipDex) orphanArgs.dex = cache.hipDex;   // HIP-3: scope to this dex
      exchangeOrders = await Promise.race([
        cache.infoClient.openOrders(orphanArgs),
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
        // Orphans were never tracked locally (no known entry/target type),
        // so there's no round trip to open for one that turns out to have
        // filled instead of cancelling — but that must not be silently
        // folded into "cleared" as if it were a clean cancel.
        const filled = result.results.filter(r => r.status && r.status.error && /filled/i.test(r.status.error) && !/never placed|already cancel/i.test(r.status.error));
        if (filled.length > 0) {
          log(botId, `⚠️ ${filled.length} orphan order(s) filled instead of cancelling — untracked position(s), please verify on the exchange`, "warn");
        }
        log(botId, `Cleared ${orphans.length - filled.length} orphan(s)${filled.length ? `, ${filled.length} filled` : ""}`, "success");
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
        const result = await cancelSingleOrder(botId, o.id, cfg.symbol);
        if (result.status === "cancelled") {
          bot.recentlyCancelled[o.id] = now;
        } else if (result.status === "filled") {
          // Orphans were never tracked locally (no known entry/target type),
          // so there's no round trip to open for it here — but this must
          // not be silently treated as "cancelled". Surface it so it can be
          // reconciled manually instead of vanishing from the logs.
          log(botId, `⚠️ Orphan order ${o.id} (${o.side} @ $${o.price}) filled instead of cancelling — untracked position, please verify on the exchange`, "warn");
        }
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

// DB-backed CSV — same layout as buildCsvReport but sourced from MySQL so it
// honours the per-coin symbol filter (the in-memory builder only sees the
// currently-running bot's single symbol). `report` is a db.queryReport result.
function buildCsvFromDbReport(report, { exchangeKey, symbol, fromTs, toTs }) {
  // Pull config from a running bot matching this symbol (for the context row).
  const cfg = (symbol
    ? (listBots().find(b => b.config?.symbol === symbol && b.exchangeKey === exchangeKey)?.config)
    : bots[exchangeKey]?.config) || {};

  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [];
  lines.push("# GRID BOT PNL REPORT");
  lines.push(`# Exchange,${esc(exchangeKey)}`);
  lines.push(`# Symbol,${esc(symbol || "ALL")}`);
  lines.push(`# Period from,${esc(new Date(fromTs).toISOString())}`);
  lines.push(`# Period to,${esc(new Date(toTs).toISOString())}`);
  lines.push(`# Generated,${esc(new Date().toISOString())}`);
  lines.push("");

  lines.push("RTPS,TOTAL_PNL,PER_STEP_QTY,AVG_SPREAD,TARGET_SPREAD,DISTANCE,TOTAL_FEES,TOTAL_REBATES,NET_PNL");
  lines.push([
    report.count,
    Number(report.pnl).toFixed(6),
    cfg.qtyPerStep ?? "",
    Number(report.avgSpread).toFixed(6),
    cfg.targetSpread ?? "",
    cfg.distance ?? "",
    Number(report.totalFees).toFixed(6),
    Number(report.totalRebates || 0).toFixed(6),
    Number(report.netPnl).toFixed(6),
  ].map(esc).join(","));
  lines.push("");

  lines.push("ROUND_TRIP,SYMBOL,OPEN_SIDE,BUY_PRICE,SELL_PRICE,QTY,SPREAD,PNL,DURATION_SEC,OPENED_AT,CLOSED_AT");
  const ordered = [...(report.roundTrips || [])].sort((a, b) => new Date(a.closeTs) - new Date(b.closeTs));
  ordered.forEach((rt, idx) => {
    lines.push([
      idx + 1,
      rt.symbol || "",
      rt.openSide,
      Number(rt.buyPrice).toFixed(6),
      Number(rt.sellPrice).toFixed(6),
      rt.qty,
      (Number(rt.sellPrice) - Number(rt.buyPrice)).toFixed(6),
      Number(rt.grossPnl ?? rt.pnl).toFixed(6),
      ((rt.durationMs || 0) / 1000).toFixed(1),
      new Date(rt.openTs).toISOString(),
      new Date(rt.closeTs).toISOString(),
    ].map(esc).join(","));
  });
  if (ordered.length === 0) lines.push("# No round trips in this period");

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
      accountName         : b.config?.accountName || null,
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

// ── Deribit options data proxy (Options Multi-Agent DB → Add Strategy) ──
// Fetched server-side so the browser never hits Deribit directly (avoids
// CORS/CSP/size hangs on the large option-chain response).
function deribitHost() {
  return String(process.env.DERIBIT_TESTNET || "").toLowerCase() === "true"
    ? "test.deribit.com" : "www.deribit.com";
}
async function deribitGet(path) {
  const r = await Promise.race([
    // "Connection: close" avoids pinning this long-lived process to a single
    // keep-alive socket for calls that are only made occasionally (the
    // instrument/option-chain lookups) — a persistent connection can end up
    // routed to a Deribit backend node whose instrument cache lags behind
    // (observed live: a fresh connection sees strikes a pinned one didn't).
    fetch(`https://${deribitHost()}${path}`, { headers: { Connection: "close" } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Deribit timeout 12s")), 12000)),
  ]);
  if (!r.ok) throw new Error(`Deribit HTTP ${r.status}`);
  const j = await r.json();
  return j.result;
}
// Merges the broad USDC-settled option chain (covers BTC/ETH/SOL/XRP/AVAX/
// TRX/HYPE) with the legacy coin-settled BTC/ETH chains. Deribit lists
// expiries more densely on the older coin-settled line (e.g. it has a expiry
// the newer USDC line skips) — merging both gives the full listing for BTC/
// ETH while still covering the alts that only exist under USDC settlement.
// Each instrument is tagged `settlement: "usdc"|"coin"` so the caller knows
// whether ticker.mark_price is already USD (usdc) or a coin fraction that
// needs x index_price (coin). Shared by the public instruments endpoint AND
// server-side order execution (which re-resolves fresh at submit time rather
// than trusting a client-cached instrument reference).
async function deribitMergedOptionChain() {
  const [usdc, btc, eth] = await Promise.all([
    deribitGet(`/api/v2/public/get_instruments?currency=USDC&kind=option&expired=false`),
    deribitGet(`/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false`),
    deribitGet(`/api/v2/public/get_instruments?currency=ETH&kind=option&expired=false`),
  ]);
  const tag = (arr, settlement) => (Array.isArray(arr) ? arr : []).map(i => ({ ...i, settlement }));
  // Coin-settled (inverse) BTC/ETH first — this account trades those, not
  // the USDC-margined line, even though collateral is held in USDC — so a
  // same-strike/expiry match prefers coin-settled (.find() takes first
  // match). usdc-settled fills in everything the coin chain doesn't have:
  // every other token (SOL/XRP/AVAX/TRX/HYPE/...), which has no coin-settled
  // line at all, plus any BTC/ETH strike/expiry the coin chain lacks.
  return [...tag(btc, "coin"), ...tag(eth, "coin"), ...tag(usdc, "usdc")];
}
app.get("/api/deribit/instruments", async (req, res) => {
  try { res.json(await deribitMergedOptionChain()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/deribit/ticker", async (req, res) => {
  const inst = req.query.instrument;
  if (!inst) return res.status(400).json({ error: "instrument required" });
  try {
    const result = await deribitGet(`/api/v2/public/ticker?instrument_name=${encodeURIComponent(inst)}`);
    res.json(result || {});
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// The exchange's own average_price/size for this instrument — used by the
// Monitor live-PnL preview instead of our own recorded entry price, since
// the account's real cost basis can drift from what we logged at entry
// (e.g. if the same instrument also carries other activity on the account,
// or the fill averaged across a re-quote). Falls back to our recorded
// entry price client-side if this returns no open position.
app.get("/api/deribit/position", async (req, res) => {
  const inst = req.query.instrument;
  if (!inst) return res.status(400).json({ error: "instrument required" });
  try {
    const result = await deribitPrivate("get_position", { instrument_name: inst }, req.query.account_id);
    res.json(result || {});
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  DERIBIT LIVE EXECUTION — Options Multi-Agent DB "Save & Execute"
//  Places REAL post-only limit orders on Deribit. Defaults to the global
//  DERIBIT_CLIENT_ID/DERIBIT_CLIENT_SECRET the grid bot already uses, but
//  every function here also accepts an optional accountId to execute
//  against a specific trading_accounts row instead — pass undefined/null
//  anywhere below and behavior is byte-identical to the single-account era.
//  No dry-run mode — every call here places a live order (mainnet unless
//  DERIBIT_TESTNET=true). Confirmation happens in the UI before this is hit.
// ══════════════════════════════════════════════════════════════
const _deribitTokenCache = new Map(); // key: accountId ?? "__global__" → { token, exp }

async function resolveDeribitCreds(accountId) {
  if (accountId == null) {
    return { key: "__global__", clientId: process.env.DERIBIT_CLIENT_ID, clientSecret: process.env.DERIBIT_CLIENT_SECRET };
  }
  const acc = await db.getAccount(parseInt(accountId, 10));
  if (!acc) throw new Error(`Deribit account ${accountId} not found`);
  if (acc.exchange !== "deribit") throw new Error(`Account ${accountId} (${acc.name}) is not a Deribit account`);
  const c = acc.credentials || {};
  if (!c.clientId || !c.clientSecret) throw new Error(`Account ${accountId} (${acc.name}) has no Deribit credentials saved`);
  return { key: String(accountId), clientId: c.clientId, clientSecret: c.clientSecret };
}

async function deribitAuthToken(accountId) {
  const { key, clientId: cid, clientSecret: secret } = await resolveDeribitCreds(accountId);
  const cached = _deribitTokenCache.get(key);
  if (cached && Date.now() < cached.exp - 30000) return cached.token;
  if (!cid || !secret) throw new Error("DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET missing in .env");
  const r = await Promise.race([
    fetch(`https://${deribitHost()}/api/v2/public/auth?grant_type=client_credentials&client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(secret)}`),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Deribit auth timeout 12s")), 12000)),
  ]);
  const j = await r.json();
  if (j.error) throw new Error(`Deribit auth failed: ${j.error.message || j.error.code}`);
  const token = j.result.access_token;
  _deribitTokenCache.set(key, { token, exp: Date.now() + (Number(j.result.expires_in) || 900) * 1000 });
  return token;
}
async function deribitPrivate(method, params, accountId) {
  const token = await deribitAuthToken(accountId);
  const qs = new URLSearchParams(params).toString();
  const r = await Promise.race([
    fetch(`https://${deribitHost()}/api/v2/private/${method}?${qs}`, { headers: { Authorization: `Bearer ${token}` } }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Deribit private call timeout 12s")), 12000)),
  ]);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || `Deribit error ${j.error.code}`);
  return j.result;
}
// Deribit rejects prices/amounts that aren't an exact multiple of the
// instrument's tick_size / min_trade_amount with a bare "Invalid params" —
// e.g. a USDC-settled option can have tick_size 0.2 below $50 and 1 above
// it (via tick_size_steps), so a raw fetched mark price like 40.4600 must
// be rounded to 40.4/40.6 before it's a legal order price.
function deribitRoundToStep(value, step) {
  if (!step) return value;
  // toFixed(10) strips the floating-point noise Math.round(v/step)*step can
  // leave behind (e.g. 40.46 -> 40.400000000000006), which would otherwise
  // get sent to Deribit verbatim and risk being rejected for excess decimals.
  return Number((Math.round(value / step) * step).toFixed(10));
}
// Directional variant used by the maker-chase engine and auto-close
// workers below — floors a buy price / ceils a sell price so rounding to
// the tick grid never nudges the order TOWARD crossing the spread (nearest
// rounding, used by deribitRoundToStep above for the older one-shot
// execute endpoint, can round up to half a tick the wrong way).
function deribitRoundToStepDirectional(value, step, dir) {
  if (!step) return value;
  const fn = dir === "sell" ? Math.ceil : Math.floor;
  return Number((fn(value / step) * step).toFixed(10));
}
function deribitTickSizeFor(inst, price) {
  let tick = inst.tick_size;
  if (Array.isArray(inst.tick_size_steps)) {
    for (const step of [...inst.tick_size_steps].sort((a, b) => a.above_price - b.above_price)) {
      if (price >= step.above_price) tick = step.tick_size;
    }
  }
  return tick;
}
// Places ONE post-only limit order. side: "buy"|"sell". Never throws —
// returns { ok:false, error } on any failure (incl. post_only_reject when
// the price would cross the spread) so the caller can report per-leg status.
async function deribitPlaceLimitOrder(instrumentName, side, amount, price, label, inst, accountId) {
  try {
    const method = side === "sell" ? "sell" : "buy";
    const roundedAmount = deribitRoundToStep(Math.abs(amount), inst?.min_trade_amount);
    const roundedPrice = deribitRoundToStep(price, deribitTickSizeFor(inst || {}, price));
    const result = await deribitPrivate(method, {
      instrument_name: instrumentName,
      amount: String(roundedAmount),
      type: "limit",
      price: String(roundedPrice),
      post_only: "true",
      label: String(label || "").slice(0, 64),
    }, accountId);
    return {
      ok: true, instrument: instrumentName, side,
      orderId: result?.order?.order_id, state: result?.order?.order_state,
      amount: roundedAmount, price: roundedPrice,
    };
  } catch (e) {
    return { ok: false, instrument: instrumentName, side, error: e.message };
  }
}
// Finds the perpetual futures instrument for a token. BTC/ETH have both a
// coin-margined perp (BTC-PERPETUAL) and a USDC-margined one
// (BTC_USDC-PERPETUAL); every other token (SOL/XRP/AVAX/TRX/HYPE/...) only
// has the USDC-margined one. Prefers matching the option leg's settlement
// currency so the whole strategy sits in one margin currency; falls back to
// whichever exists.
async function deribitFindPerpetual(token, preferSettlement) {
  const usdcFutures = await deribitGet(`/api/v2/public/get_instruments?currency=USDC&kind=future&expired=false`);
  const usdcPerp = (usdcFutures || []).find(f => f.base_currency === token && f.instrument_name.endsWith("-PERPETUAL"));
  let coinPerp = null;
  if (token === "BTC" || token === "ETH") {
    const coinFutures = await deribitGet(`/api/v2/public/get_instruments?currency=${token}&kind=future&expired=false`);
    coinPerp = (coinFutures || []).find(f => f.instrument_name === `${token}-PERPETUAL`);
  }
  if (preferSettlement === "coin" && coinPerp) return { ...coinPerp, settlement: "coin" };
  if (usdcPerp) return { ...usdcPerp, settlement: "usdc" };
  if (coinPerp) return { ...coinPerp, settlement: "coin" };
  return null;
}

// ══════════════════════════════════════════════════════════════
//  MAKER-CHASE EXECUTION ENGINE + AUTO-CLOSE — ported from the
//  options_pnl_report app's deribit-order/deribit-close-helpers/
//  auto-close-worker logic, adapted to the single global Deribit
//  account (deribitAuthToken()/deribitPrivate() above already handle
//  that — no per-account credential lookup here).
// ══════════════════════════════════════════════════════════════

// Inverse futures (ETH-PERPETUAL, BTC-PERPETUAL) are quoted in USD notional
// with a fixed contract size (1 USD for ETH, 10 USD for BTC) — "amount" must
// be an integer multiple of contract_size, not a raw coin qty. Options and
// linear futures take "amount" as a number of CONTRACTS — for BTC/ETH,
// contract_size is 1 so raw coin qty and contract count coincide, but
// altcoin instruments (SOL_USDC, XRP_USDC, ...) use contract_size > 1 (e.g.
// 1 contract = 10 SOL) and the coin qty must be divided down to contracts.
async function deribitOrderAmount(inst, qty) {
  const absQty = Math.abs(Number(qty));
  const isInverseFuture = inst?.kind === "future" && inst?.future_type && inst.future_type !== "linear";
  const contractSize = inst?.contract_size || 1;
  if (!isInverseFuture) {
    if (contractSize > 1) return Math.max(1, Math.round(absQty / contractSize));
    return absQty;
  }
  let refPrice = 0;
  try {
    const t = await deribitGet(`/api/v2/public/ticker?instrument_name=${encodeURIComponent(inst.instrument_name)}`);
    refPrice = t?.mark_price || t?.last_price || t?.index_price || 0;
  } catch (e) { /* fall through, use raw qty below */ }
  if (refPrice <= 0) return absQty;
  return Math.max(contractSize, Math.round((absQty * refPrice) / contractSize) * contractSize);
}

// Inverse contracts (ETH, BTC) hold collateral in the coin itself. Linear
// USDC-margined contracts (SOL_USDC, XRP_USDC, ...) settle entirely in
// USDC — there is no separate coin wallet on Deribit for those.
function deribitCoinLegFor(token) {
  const t = (token || "ETH").toUpperCase();
  if (t.includes("_USDC") || t.includes("_USDT")) return null;
  return t;
}
// Combined coin-wallet + USDC-wallet equity (USD) — the auto-close worker's
// target-PnL tracking is against this combined total, not a single wallet.
async function deribitCollateral(token, accountId) {
  const coinSymbol = deribitCoinLegFor(token);
  const [coinR, usdcR] = await Promise.allSettled([
    coinSymbol ? deribitPrivate("get_account_summary", { currency: coinSymbol, extended: "false" }, accountId) : Promise.resolve(null),
    deribitPrivate("get_account_summary", { currency: "USDC", extended: "false" }, accountId),
  ]);
  let coinIndex = 0;
  if (coinSymbol) {
    try { coinIndex = (await deribitGet(`/api/v2/public/get_index_price?index_name=${coinSymbol.toLowerCase()}_usd`))?.index_price || 0; }
    catch (e) { /* leave at 0 */ }
  }
  const coinEquity = coinSymbol && coinR.status === "fulfilled" ? (coinR.value?.equity ?? 0) : 0;
  const usdcEquity = usdcR.status === "fulfilled" ? (usdcR.value?.equity ?? 0) : 0;
  const coinUsd = coinEquity * coinIndex;
  return {
    coin_symbol: coinSymbol || "USDC",
    coin_equity: coinEquity,
    coin_equity_usd: coinUsd,
    usdc_equity: usdcEquity,
    total_usd: coinUsd + usdcEquity,
  };
}

// Checks the REAL position on the exchange rather than trusting our own
// order tracking — catches an option that auto-settled at expiry (no order
// of ours involved) and an overlapping tick that already closed it.
async function deribitPositionFlat(instrument, accountId) {
  if (!instrument) return true;
  try {
    const pos = await deribitPrivate("get_position", { instrument_name: instrument }, accountId);
    return Math.abs(parseFloat(pos?.size ?? 0)) === 0;
  } catch (e) { return false; } // never assume closed on an API error
}

async function deribitIsOptionExpired(instrument) {
  if (!instrument) return false;
  try {
    const info = await deribitGet(`/api/v2/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`);
    if (!info) return false;
    return !!(info.expiration_timestamp && Date.now() >= info.expiration_timestamp);
  } catch (e) { return false; } // never assume expired on any uncertainty
}

// Maker limit close at the current mid, rounded to tick — used by the
// auto-close workers for the option leg (never falls back to market).
async function deribitPlaceLimitClose(instrument, qty, dir, accountId) {
  const [ticker, info] = await Promise.all([
    deribitGet(`/api/v2/public/ticker?instrument_name=${encodeURIComponent(instrument)}`),
    deribitGet(`/api/v2/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`),
  ]);
  const bid = ticker?.best_bid_price || 0, ask = ticker?.best_ask_price || 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ticker?.mark_price || 0);
  const tick = deribitTickSizeFor(info || {}, mid);
  const price = deribitRoundToStepDirectional(Math.max(mid, tick || 0), tick, dir);
  const amount = await deribitOrderAmount(info, qty);
  return deribitPrivate(dir, {
    instrument_name: instrument, amount: String(amount), type: "limit",
    price: String(price), reduce_only: "true",
  }, accountId);
}
async function deribitPlaceMarketClose(instrument, qty, dir, accountId) {
  const info = await deribitGet(`/api/v2/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`);
  const amount = await deribitOrderAmount(info, qty);
  return deribitPrivate(dir, { instrument_name: instrument, amount: String(amount), type: "market", reduce_only: "true" }, accountId);
}

// Fire-and-forget-friendly Telegram sender for the auto-close workers —
// reuses the SAME TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID the rest of the bot
// already sends alerts with, via the existing tgPost() RPC helper. Never
// throws; returns {ok, error?} so callers can persist the outcome into a
// job's own log instead of it only ever showing up in server console output.
async function sendTelegramAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    const error = "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env — skipping alert";
    console.warn(`[telegram] ${error}`);
    return { ok: false, error };
  }
  try {
    const r = await tgPost("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
    if (!r?.ok) return { ok: false, error: r?.description || "unknown" };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Places the option leg (required) and, if the strategy has a futures leg,
// the futures leg too — both as post-only limit orders at the strategy's
// saved prices. Re-resolves the live instrument fresh from Deribit rather
// than trusting anything cached client-side, so execution always targets a
// currently-listed instrument.
app.post("/api/options-db/trades/:id/execute", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  const id = parseInt(req.params.id, 10);
  try {
    const trade = await db.getOptionsTrade(id);
    if (!trade) return res.status(404).json({ error: "Not found." });

    const token = String(trade.token || "").split(/[-_]/)[0].toUpperCase();
    const optionType = String(trade.option_type || "PUT").toLowerCase();
    const strike = db.optStrikeNumber(trade.options_strike);
    const expiryDateStr = trade.expiry ? new Date(trade.expiry).toISOString().slice(0, 10) : null;
    const qty = Number(trade.opt_entry_qty) || 0;
    const price = Number(trade.opt_entry_price) || 0;

    if (!token || !expiryDateStr || !strike || !qty || !price) {
      return res.status(400).json({ error: "Missing token/expiry/strike/qty/entry price — pick them via the live dropdowns first." });
    }

    const chain = await deribitMergedOptionChain();
    const inst = chain.find(i =>
      i.base_currency === token &&
      new Date(i.expiration_timestamp).toISOString().slice(0, 10) === expiryDateStr &&
      i.option_type === optionType &&
      String(i.strike) === String(strike));
    if (!inst) {
      return res.status(400).json({ error: `No live Deribit instrument matches ${token} ${expiryDateStr} ${optionType.toUpperCase()} ${strike} — it may have expired or isn't currently listed.` });
    }

    const optSide = qty > 0 ? "buy" : "sell";
    let optResult;
    try {
      // Coin-settled (inverse) options are priced in the underlying COIN, not
      // USD — e.g. a $44.90 option might be "0.0259 ETH". opt_entry_price is
      // always stored/displayed in USD, so it must be converted back to coin
      // terms (divide by the live index) before it's a legal order price;
      // sending the raw USD number gets rejected as price_too_high (Deribit
      // reads 44.90 as 44.90 ETH). USDC-settled options are already USD.
      let optPriceForOrder = price;
      if (inst.settlement === "coin") {
        const ticker = await deribitGet(`/api/v2/public/ticker?instrument_name=${encodeURIComponent(inst.instrument_name)}`);
        const index = Number(ticker?.index_price ?? ticker?.underlying_price) || 0;
        if (!index) throw new Error("Could not fetch a live index price to convert the coin-settled option's price");
        optPriceForOrder = price / index;
      }
      optResult = await deribitPlaceLimitOrder(inst.instrument_name, optSide, qty, optPriceForOrder, `optdb_${id}_opt`, inst, trade.account_id);
    } catch (e) {
      optResult = { ok: false, instrument: inst.instrument_name, side: optSide, error: e.message };
    }

    let futResult = null;
    const futQty = Number(trade.fut_qty) || 0;
    const futPrice = Number(trade.fut_entry_price) || 0;
    if (futQty && futPrice) {
      const perp = await deribitFindPerpetual(token, inst.settlement);
      if (!perp) {
        futResult = { ok: false, error: `No perpetual futures instrument found for ${token}` };
      } else {
        const futSide = futQty > 0 ? "buy" : "sell";
        // Coin-margined ("reversed") perpetuals like ETH-PERPETUAL size
        // amount in USD, not the coin — 1 contract = $1 notional (min_trade
        // amount 1). fut_qty is stored/entered in coin units everywhere else
        // in the app (matching the linear USDC-margined perpetual, where
        // amount really is in coin), so it has to be converted to USD
        // notional (qty × entry price) before it's a legal order size, or a
        // "1.3" short silently becomes a ~$1 position instead of ~$1.3×price.
        const futAmount = perp.instrument_type === "reversed" ? Math.abs(futQty) * futPrice : futQty;
        futResult = await deribitPlaceLimitOrder(perp.instrument_name, futSide, futAmount, futPrice, `optdb_${id}_fut`, perp, trade.account_id);
      }
    }

    await db.recordOptionsExecution(id, { option: optResult, futures: futResult, executedAt: new Date().toISOString() });
    res.json({ ok: true, option: optResult, futures: futResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Order placement primitive — the maker-chase engine's building block.
// The frontend (Add Strategy / Combined Simulator) calls this once per
// order: place at mid (chase loop re-calls this on every re-quote), poll
// state via GET, cancel via DELETE if the mid has drifted. Unlike
// /api/options-db/trades/:id/execute above (one-shot, strict post_only),
// this defaults post_only OFF — a limit priced exactly at a fresh mid can't
// normally cross the book, but if the market ticks before the order lands,
// post_only:false lets it fill immediately as a taker instead of being
// rejected and forcing a manual retry.
app.post("/api/deribit-order", async (req, res) => {
  const { instrument, qty, direction, price, is_market = false, post_only = true, account_id } = req.body || {};
  if (!instrument || qty == null || !direction) {
    return res.status(400).json({ error: "instrument, qty, direction required" });
  }
  try {
    const info = await deribitGet(`/api/v2/public/get_instrument?instrument_name=${encodeURIComponent(instrument)}`);
    let effectivePrice = null;
    if (!is_market && price != null && price > 0) {
      const tick = deribitTickSizeFor(info || {}, price);
      // Directional (floor buy / ceil sell) so rounding to the tick grid
      // never nudges a maker order toward crossing the spread.
      effectivePrice = deribitRoundToStepDirectional(price, tick, direction);
      if (effectivePrice <= 0) effectivePrice = tick;
    }
    const amount = await deribitOrderAmount(info, qty);
    const params = {
      instrument_name: instrument,
      amount: String(amount),
      type: effectivePrice ? "limit" : "market",
    };
    if (effectivePrice) {
      params.price = String(effectivePrice);
      if (post_only) params.post_only = "true";
    }
    const method = direction === "buy" ? "buy" : "sell";
    const result = await deribitPrivate(method, params, account_id);
    const order = result?.order || {};
    res.json({
      ok: true, order_id: order.order_id, amount: order.amount,
      filled_amount: order.filled_amount, order_state: order.order_state, price: order.price,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/deribit-order", async (req, res) => {
  const orderId = req.query.order_id;
  if (!orderId) return res.status(400).json({ error: "order_id required" });
  try {
    const result = await deribitPrivate("get_order_state", { order_id: orderId }, req.query.account_id);
    res.json({
      ok: true, order_id: result.order_id, instrument: result.instrument_name,
      amount: result.amount, filled_amount: result.filled_amount,
      order_state: result.order_state, price: result.price,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/deribit-order", async (req, res) => {
  const orderId = req.query.order_id;
  if (!orderId) return res.status(400).json({ error: "order_id required" });
  try {
    const result = await deribitPrivate("cancel", { order_id: orderId }, req.query.account_id);
    res.json({ ok: true, order_id: result.order_id, filled_amount: result.filled_amount, order_state: result.order_state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/deribit/collateral", async (req, res) => {
  try { res.json(await deribitCollateral(req.query.token || "ETH", req.query.account_id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Resolves the right perpetual futures instrument for a token — the
// maker-chase engine (client-orchestrated) needs the instrument name
// before it can call /api/deribit-order for the futures hedge leg,
// unlike the old one-shot /api/options-db/trades/:id/execute above which
// resolves it server-side internally.
app.get("/api/deribit/perpetual", async (req, res) => {
  try {
    const perp = await deribitFindPerpetual(String(req.query.token || "").toUpperCase(), req.query.prefer);
    res.json(perp || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fires once per successful Execute (Add Strategy: single leg; Combined
// Simulator: every leg that filled) — independent of whether Auto-Close is
// also started, so a plain Execute still gets an entry confirmation.
// legs: [{ leg_type?, opt_instrument?, opt_price?, fut_instrument?, fut_price? }]
app.post("/api/entry-alert", async (req, res) => {
  try {
    const { token, legs, account_id } = req.body || {};
    if (!token || !Array.isArray(legs) || !legs.length) {
      return res.status(400).json({ error: "token and legs[] required" });
    }
    const col = await deribitCollateral(token, account_id).catch(() => null);
    const multi = legs.length > 1;
    const legLines = legs.map((l, i) => {
      const prefix = multi ? `<b>Leg ${i + 1}${l.leg_type ? ` (${l.leg_type})` : ""}</b>` : "";
      const parts = [prefix].filter(Boolean);
      if (l.opt_instrument && l.opt_price != null) parts.push(`${multi ? "  " : ""}Option: ${l.opt_instrument} @ $${Number(l.opt_price).toFixed(4)}`);
      if (l.fut_instrument && l.fut_price != null) parts.push(`${multi ? "  " : ""}Futures: ${l.fut_instrument} @ $${Number(l.fut_price).toFixed(2)}`);
      return parts.join("\n");
    }).filter((s) => s.trim());
    const lines = [
      `🟢 <b>${multi ? "Combined Strategy" : "Strategy"} Entered</b>`,
      ...legLines,
      ``,
      `Initial collateral: $${(col?.total_usd ?? 0).toFixed(2)}`,
    ];
    const alert = await sendTelegramAlert(lines.join("\n"));
    res.json({ ok: alert.ok, error: alert.error });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AUTO-CLOSE JOBS — single-leg (Add Strategy) + combo (Combined
//  Simulator). CRUD here; the actual polling logic that drives status
//  transitions lives in autoCloseWorkerTick()/autoCloseComboWorkerTick()
//  below, started once at server boot.
// ══════════════════════════════════════════════════════════════
app.get("/api/auto-close", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const jobId = req.query.id;
    if (jobId) {
      const job = await db.getAutoCloseJob(jobId);
      if (!job) return res.status(404).json({ error: "not found" });
      return res.json({ job });
    }
    const jobs = await db.listAutoCloseJobs({ tradeId: req.query.trade_id });
    res.json({ jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/auto-close", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const body = req.body || {};
    const missing = ["token", "opt_instrument", "opt_qty", "opt_dir", "initial_total_usd", "target_pnl"]
      .filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });

    if (body.trade_id) {
      const existing = await db.findActiveAutoCloseJob(body.trade_id);
      if (existing) {
        return res.status(409).json({
          error: `Job #${existing.id} is already ${existing.status} for this strategy. Stop it before starting a new one.`,
          existing_job_id: existing.id,
        });
      }
    }

    const initialTotal = parseFloat(body.initial_total_usd);
    const targetPnl = parseFloat(body.target_pnl);
    const targetTotal = initialTotal + targetPnl;
    const jobId = await db.insertAutoCloseJob({
      trade_id: body.trade_id || null,
      token: body.token,
      opt_instrument: body.opt_instrument,
      opt_qty: parseFloat(body.opt_qty),
      opt_dir: body.opt_dir,
      opt_entry_price: body.opt_entry_price != null && body.opt_entry_price !== "" ? parseFloat(body.opt_entry_price) : null,
      fut_instrument: body.fut_instrument || "",
      fut_qty: parseFloat(body.fut_qty) || 0,
      fut_dir: body.fut_dir || "sell",
      fut_entry_price: body.fut_entry_price != null && body.fut_entry_price !== "" ? parseFloat(body.fut_entry_price) : null,
      initial_total_usd: initialTotal,
      target_pnl: targetPnl,
      target_total_usd: targetTotal,
      account_id: body.account_id || null,
    });

    startAutoCloseWorker();
    const alert = await sendTelegramAlert(
      [
        `🟢 <b>Auto-Close Monitor Started</b> — Job #${jobId}`,
        `${body.opt_instrument}${body.fut_instrument ? ` + ${body.fut_instrument}` : ""}`,
        ``,
        `Initial collateral: $${initialTotal.toFixed(2)}`,
        `Target: +$${targetPnl.toFixed(2)} → closes at $${targetTotal.toFixed(2)}`,
      ].join("\n")
    );
    await db.appendAutoCloseLog(jobId, alert.ok ? "Telegram entry alert sent." : `Telegram entry alert FAILED: ${alert.error}`);
    res.json({ id: jobId, target_total_usd: targetTotal, telegram_ok: alert.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/auto-close", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const newTargetPnl = parseFloat(req.body?.target_pnl);
    if (!(newTargetPnl > 0)) return res.status(400).json({ error: "target_pnl must be a number > 0" });
    const job = await db.getAutoCloseJobRaw(id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (job.status !== "active") return res.status(400).json({ error: `Job is ${job.status} — target can only be edited while still active` });
    const newTargetTotal = parseFloat(job.initial_total_usd) + newTargetPnl;
    await db.updateAutoCloseJob(id, { target_pnl: newTargetPnl, target_total_usd: newTargetTotal, approach_alert_sent: 0 });
    res.json({ ok: true, target_pnl: newTargetPnl, target_total_usd: newTargetTotal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/auto-close", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const job = await db.getAutoCloseJobRaw(id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (["completed", "failed", "stopped"].includes(job.status)) return res.status(400).json({ error: `Job already ${job.status}` });
    await db.updateAutoCloseJob(id, { status: "stopped", completed: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auto-close-combo", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const jobId = req.query.id;
    if (jobId) {
      const job = await db.getComboJob(jobId);
      if (!job) return res.status(404).json({ error: "not found" });
      const legs = await db.getComboJobLegs(jobId);
      return res.json({ job, legs });
    }
    const jobs = await db.listComboJobs({ groupId: req.query.group_id });
    res.json({ jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/auto-close-combo", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const body = req.body || {};
    const missing = ["token", "initial_total_usd", "target_pnl"].filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
    if (!Array.isArray(body.legs) || !body.legs.length) return res.status(400).json({ error: "legs must be a non-empty array" });

    if (body.group_id) {
      const existing = await db.findActiveComboJob(body.group_id);
      if (existing) {
        return res.status(409).json({
          error: `Job #${existing.id} is already ${existing.status} for this combo. Stop it before starting a new one.`,
          existing_job_id: existing.id,
        });
      }
    }

    const initialTotal = parseFloat(body.initial_total_usd);
    const targetPnl = parseFloat(body.target_pnl);
    const targetTotal = initialTotal + targetPnl;
    const jobId = await db.insertComboJob(
      { group_id: body.group_id || null, token: body.token, initial_total_usd: initialTotal, target_pnl: targetPnl, target_total_usd: targetTotal, account_id: body.account_id || null },
      body.legs.map((leg) => ({
        leg_type: leg.leg_type || null,
        opt_instrument: leg.opt_instrument || "", opt_qty: parseFloat(leg.opt_qty) || 0, opt_dir: leg.opt_dir || "sell",
        opt_entry_price: leg.opt_entry_price != null && leg.opt_entry_price !== "" ? parseFloat(leg.opt_entry_price) : null,
        fut_instrument: leg.fut_instrument || "", fut_qty: parseFloat(leg.fut_qty) || 0, fut_dir: leg.fut_dir || "sell",
        fut_entry_price: leg.fut_entry_price != null && leg.fut_entry_price !== "" ? parseFloat(leg.fut_entry_price) : null,
      }))
    );

    startAutoCloseComboWorker();
    const legSummary = body.legs.map((leg, i) => {
      const bits = [`Leg ${i + 1} (${leg.leg_type || "?"}): ${leg.opt_instrument || "—"}`];
      if (leg.opt_entry_price) bits.push(`opt $${parseFloat(leg.opt_entry_price).toFixed(4)}`);
      if (leg.fut_entry_price) bits.push(`fut $${parseFloat(leg.fut_entry_price).toFixed(2)}`);
      return bits.join(" · ");
    });
    const alert = await sendTelegramAlert(
      [
        `🟢 <b>Combo Auto-Close Monitor Started</b> — Job #${jobId}`,
        `${body.legs.length} legs`, ``, ...legSummary, ``,
        `Initial collateral: $${initialTotal.toFixed(2)}`,
        `Target: +$${targetPnl.toFixed(2)} → closes at $${targetTotal.toFixed(2)}`,
      ].join("\n")
    );
    await db.appendComboLog(jobId, alert.ok ? "Telegram entry alert sent." : `Telegram entry alert FAILED: ${alert.error}`);
    res.json({ id: jobId, target_total_usd: targetTotal, telegram_ok: alert.ok });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/auto-close-combo", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const newTargetPnl = parseFloat(req.body?.target_pnl);
    if (!(newTargetPnl > 0)) return res.status(400).json({ error: "target_pnl must be a number > 0" });
    const job = await db.getComboJobRaw(id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (job.status !== "active") return res.status(400).json({ error: `Job is ${job.status} — target can only be edited while still active` });
    const newTargetTotal = parseFloat(job.initial_total_usd) + newTargetPnl;
    await db.updateComboJob(id, { target_pnl: newTargetPnl, target_total_usd: newTargetTotal, approach_alert_sent: 0 });
    res.json({ ok: true, target_pnl: newTargetPnl, target_total_usd: newTargetTotal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/auto-close-combo", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "id required" });
    const job = await db.getComboJobRaw(id);
    if (!job) return res.status(404).json({ error: "not found" });
    if (["completed", "failed", "stopped"].includes(job.status)) return res.status(400).json({ error: `Job already ${job.status}` });
    await db.updateComboJob(id, { status: "stopped", completed: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  AUTO-CLOSE WORKERS — in-process 5s pollers, ported from the
//  options_pnl_report app's lib/auto-close-worker.js and
//  lib/auto-close-combo-worker.js. server.js is a single long-running
//  process (no hot-reload here, unlike Next.js dev), so the source's
//  globalThis HMR-survival guards are dropped — a plain module-level
//  flag is enough to make start*() idempotent.
// ══════════════════════════════════════════════════════════════
const AC_APPROACH_THRESHOLD   = 0.9;   // heads-up alert once PnL hits 90% of target
const AC_OPT_REQUOTE_THRESHOLD = 0.00005;
const AC_ERROR_THRESHOLD      = 12;    // ~1 min of continuous failures before giving up

let _autoCloseRunning = false;
function startAutoCloseWorker() {
  if (_autoCloseRunning) return;
  _autoCloseRunning = true;
  console.log("[auto-close] worker started");
  autoCloseWorkerTick();
  setInterval(autoCloseWorkerTick, 5000);
}

async function autoCloseWorkerTick() {
  let jobs;
  try { jobs = await db.listActiveAutoCloseJobs(); }
  catch (e) { console.error("[auto-close] DB query failed:", e.message); return; }
  for (const job of jobs) {
    try {
      await autoCloseProcessJob(job);
      if (job.consecutive_errors) await db.updateAutoCloseJob(job.id, { consecutive_errors: 0 });
    } catch (err) {
      const nextCount = (job.consecutive_errors || 0) + 1;
      console.error(`[auto-close #${job.id}] error ${nextCount}/${AC_ERROR_THRESHOLD}:`, err.message);
      if (nextCount >= AC_ERROR_THRESHOLD) {
        await db.appendAutoCloseLog(job.id, `Fatal error after ${nextCount} consecutive failures: ${err.message}`).catch(() => {});
        await db.updateAutoCloseJob(job.id, { status: "failed", error_msg: err.message, completed: true }).catch(() => {});
      } else {
        await db.updateAutoCloseJob(job.id, { consecutive_errors: nextCount }).catch(() => {});
      }
    }
  }
}

async function autoCloseProcessJob(job) {
  if (job.status === "active") {
    // An option can expire before the profit target is ever hit — Deribit
    // settles it automatically with no order of ours involved.
    if (await deribitIsOptionExpired(job.opt_instrument)) {
      await db.appendAutoCloseLog(job.id, `Option ${job.opt_instrument} has expired — closing the futures hedge and ending the monitor.`);
      await sendTelegramAlert([
        `⏰ <b>Strike Expired</b> — Job #${job.id}`,
        `${job.opt_instrument} expired before the +$${parseFloat(job.target_pnl).toFixed(2)} target was reached.`,
        job.fut_instrument ? `Closing the futures hedge (${job.fut_instrument}) now.` : `No futures hedge to close.`,
      ].join("\n"));
      const hasFutures = parseFloat(job.fut_qty || 0) !== 0;
      await db.updateAutoCloseJob(job.id, hasFutures ? { status: "closing_futures" } : { status: "completed", completed: true });
      const fresh = await db.getAutoCloseJobRaw(job.id);
      if (hasFutures) await autoCloseCloseFutures(fresh); else await autoCloseFinishJob(job.id);
      return;
    }

    const col = await deribitCollateral(job.token, job.account_id);
    // Track against the COIN wallet's equity only, not coin+USDC combined —
    // the options/futures position only ever moves the coin side; folding
    // in USDC (which can drift from unrelated account activity) can mask a
    // real coin-side loss or falsely bring the target closer.
    const equity = col.coin_equity_usd;
    const pnl = equity - parseFloat(job.initial_total_usd);
    const targetPnl = parseFloat(job.target_pnl);
    await db.updateAutoCloseJob(job.id, { last_checked_at: new Date(), last_equity_usd: equity });

    if (!job.approach_alert_sent && targetPnl > 0 && pnl >= targetPnl * AC_APPROACH_THRESHOLD) {
      await db.updateAutoCloseJob(job.id, { approach_alert_sent: 1 });
      await sendTelegramAlert([
        `⚠️ <b>Auto-Close Approaching Target</b> — Job #${job.id}`,
        `${job.opt_instrument}${job.fut_instrument ? ` + ${job.fut_instrument}` : ""}`, ``,
        `PnL: +$${pnl.toFixed(2)} / target +$${targetPnl.toFixed(2)} (${((pnl / targetPnl) * 100).toFixed(1)}%)`,
        `Auto-close will trigger soon — keep an eye on it.`,
      ].join("\n"));
    }

    if (equity >= parseFloat(job.target_total_usd)) {
      await db.appendAutoCloseLog(job.id,
        `TARGET HIT — ${col.coin_symbol} equity $${col.coin_equity_usd.toFixed(2)} (USDC $${col.usdc_equity.toFixed(2)} not counted) | PnL +$${pnl.toFixed(2)}`);
      await db.updateAutoCloseJob(job.id, { status: "closing_option", triggered: true });
      const fresh = await db.getAutoCloseJobRaw(job.id);
      await autoCloseCloseOption(fresh);
    }
    return;
  }
  if (job.status === "closing_option") return autoCloseCloseOption(job);
  if (job.status === "closing_futures") return autoCloseCloseFutures(job);
}

// Options always close as a maker at the mid price — never falls back to
// market, re-quoting every tick if the mid drifts (same chase behavior as
// the entry engine). Futures still close at market — the hedge needs to
// come off immediately once the option leg is done.
async function autoCloseCloseOption(job) {
  const optQty = parseFloat(job.opt_qty);

  if (await deribitPositionFlat(job.opt_instrument, job.account_id)) {
    let closePrice = null;
    if (job.opt_order_id) {
      try {
        const state = await deribitPrivate("get_order_state", { order_id: job.opt_order_id }, job.account_id);
        closePrice = parseFloat(state.average_price ?? state.price ?? 0) || null;
      } catch (e) { /* order no longer queryable — leave unknown */ }
    }
    await db.appendAutoCloseLog(job.id, `Option position already flat (${job.opt_instrument})${closePrice != null ? ` — filled @ ${closePrice}` : " — expired/settled or closed outside the worker"}.`);
    const hasFutures = parseFloat(job.fut_qty || 0) !== 0;
    const patch = hasFutures ? { status: "closing_futures" } : { status: "completed", completed: true };
    if (closePrice != null) patch.opt_close_price = closePrice;
    await db.updateAutoCloseJob(job.id, patch);
    const fresh = await db.getAutoCloseJobRaw(job.id);
    if (hasFutures) await autoCloseCloseFutures(fresh); else await autoCloseFinishJob(job.id);
    return;
  }

  if (job.opt_order_id) {
    const state = await deribitPrivate("get_order_state", { order_id: job.opt_order_id }, job.account_id);

    if (state.order_state === "filled") {
      const filled = parseFloat(state.filled_amount ?? state.amount ?? Math.abs(optQty));
      const closePrice = parseFloat(state.average_price ?? state.price ?? 0);
      const hasFutures = parseFloat(job.fut_qty || 0) !== 0;
      await db.appendAutoCloseLog(job.id, `Option order ${job.opt_order_id} filled: ${filled}x ${job.opt_instrument} @ ${closePrice}`);
      await db.updateAutoCloseJob(job.id, {
        opt_filled_qty: filled, opt_close_price: closePrice,
        status: hasFutures ? "closing_futures" : "completed",
        ...(hasFutures ? {} : { completed: true }),
      });
      const fresh = await db.getAutoCloseJobRaw(job.id);
      if (hasFutures) await autoCloseCloseFutures(fresh); else await autoCloseFinishJob(job.id);
      return;
    }

    if (state.order_state === "cancelled" || state.order_state === "rejected") {
      await db.appendAutoCloseLog(job.id, `Option order ${job.opt_order_id} ${state.order_state} — re-placing.`);
      await db.updateAutoCloseJob(job.id, { opt_order_id: null });
      return;
    }

    const ticker = await deribitGet(`/api/v2/public/ticker?instrument_name=${encodeURIComponent(job.opt_instrument)}`);
    const bid = ticker?.best_bid_price || 0, ask = ticker?.best_ask_price || 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ticker?.mark_price || 0);
    const orderPrice = parseFloat(state.price ?? 0);

    if (mid > 0 && Math.abs(mid - orderPrice) > AC_OPT_REQUOTE_THRESHOLD) {
      await db.appendAutoCloseLog(job.id, `Option mid moved ${orderPrice.toFixed(5)} → ${mid.toFixed(5)}, re-quoting maker order...`);
      try { await deribitPrivate("cancel", { order_id: job.opt_order_id }, job.account_id); } catch (e) { /* already filled/cancelled */ }
      await db.updateAutoCloseJob(job.id, { opt_order_id: null });
      const fresh = await db.getAutoCloseJobRaw(job.id);
      await autoCloseCloseOption(fresh);
    }
    return;
  }

  const result = await deribitPlaceLimitClose(job.opt_instrument, optQty, job.opt_dir, job.account_id);
  const orderId = result?.order?.order_id, price = result?.order?.price;
  await db.appendAutoCloseLog(job.id, `Option maker close placed: ${Math.abs(optQty)}x ${job.opt_instrument} @ ${price} [order ${orderId}]`);
  await db.updateAutoCloseJob(job.id, { opt_order_id: orderId, opt_placed: true });
}

async function autoCloseCloseFutures(job) {
  const futQty = parseFloat(job.fut_qty || 0);
  if (futQty === 0 || !job.fut_instrument) {
    await db.appendAutoCloseLog(job.id, "No futures position — strategy complete.");
    await db.updateAutoCloseJob(job.id, { status: "completed", completed: true });
    await autoCloseFinishJob(job.id);
    return;
  }
  if (await deribitPositionFlat(job.fut_instrument, job.account_id)) {
    await db.appendAutoCloseLog(job.id, `Futures position already flat (${job.fut_instrument}) — nothing left to close.`);
    await db.updateAutoCloseJob(job.id, { status: "completed", completed: true });
    await autoCloseFinishJob(job.id);
    return;
  }
  const result = await deribitPlaceMarketClose(job.fut_instrument, futQty, job.fut_dir, job.account_id);
  const orderId = result?.order?.order_id;
  const closePrice = parseFloat(result?.order?.average_price ?? result?.order?.price ?? 0);
  await db.appendAutoCloseLog(job.id, `Futures market close placed: ${Math.abs(futQty)}x ${job.fut_instrument} @ ${closePrice} [order ${orderId}]`);
  await db.updateAutoCloseJob(job.id, { status: "completed", completed: true, fut_close_price: closePrice });
  await autoCloseFinishJob(job.id);
}

async function autoCloseFinishJob(jobId) {
  try {
    const job = await db.getAutoCloseJobRaw(jobId);
    if (!job) return;
    const col = await deribitCollateral(job.token, job.account_id).catch(() => null);
    const finalEquity = col?.coin_equity_usd ?? parseFloat(job.last_equity_usd ?? job.initial_total_usd);
    await db.updateAutoCloseJob(jobId, { final_equity_usd: finalEquity });
    // Snapshot the job's own audit trail onto its trade row too, so it
    // survives even if this job record is later cleaned up.
    if (job.trade_id) {
      await db.updateOptionsTrade(job.trade_id, {
        execution_log: job.log_json, target_pnl: job.target_pnl, initial_collateral_usd: job.initial_total_usd,
      }).catch((e) => console.error(`[auto-close #${jobId}] trade snapshot failed:`, e.message));
    }
    const initial = parseFloat(job.initial_total_usd);
    const netDiff = finalEquity - initial;
    const optEntry = job.opt_entry_price != null ? parseFloat(job.opt_entry_price) : null;
    const optClose = job.opt_close_price != null ? parseFloat(job.opt_close_price) : null;
    const futEntry = job.fut_entry_price != null ? parseFloat(job.fut_entry_price) : null;
    const futClose = job.fut_close_price != null ? parseFloat(job.fut_close_price) : null;
    const lines = [
      `✅ <b>Auto-Close Complete</b> — Job #${jobId}`,
      `${job.opt_instrument}${job.fut_instrument ? ` + ${job.fut_instrument}` : ""}`, ``,
      optEntry != null ? `Option: entry $${optEntry.toFixed(4)} → close ${optClose != null ? "$" + optClose.toFixed(4) : "—"}` : null,
      job.fut_instrument && futEntry != null ? `Futures: entry $${futEntry.toFixed(2)} → close ${futClose != null ? "$" + futClose.toFixed(2) : "—"}` : null,
      ``,
      `Initial collateral: $${initial.toFixed(2)}`,
      `Final collateral: $${finalEquity.toFixed(2)}`,
      `<b>Net PnL: ${netDiff >= 0 ? "+" : ""}$${netDiff.toFixed(2)}</b>`,
    ].filter(Boolean);
    await sendTelegramAlert(lines.join("\n"));
  } catch (e) { console.error(`[auto-close #${jobId}] finish-job alert failed:`, e.message); }
}

// ── Combo (multi-leg) auto-close worker — same design, extended to N
// option+futures leg pairs sharing one combined-equity target. ─────────────
let _autoCloseComboRunning = false;
function startAutoCloseComboWorker() {
  if (_autoCloseComboRunning) return;
  _autoCloseComboRunning = true;
  console.log("[auto-close-combo] worker started");
  autoCloseComboWorkerTick();
  setInterval(autoCloseComboWorkerTick, 5000);
}

async function autoCloseComboWorkerTick() {
  let jobs;
  try { jobs = await db.listActiveComboJobs(); }
  catch (e) { console.error("[auto-close-combo] DB query failed:", e.message); return; }
  for (const job of jobs) {
    try {
      await autoCloseComboProcessJob(job);
      if (job.consecutive_errors) await db.updateComboJob(job.id, { consecutive_errors: 0 });
    } catch (err) {
      const nextCount = (job.consecutive_errors || 0) + 1;
      console.error(`[auto-close-combo #${job.id}] error ${nextCount}/${AC_ERROR_THRESHOLD}:`, err.message);
      if (nextCount >= AC_ERROR_THRESHOLD) {
        await db.appendComboLog(job.id, `Fatal error after ${nextCount} consecutive failures: ${err.message}`).catch(() => {});
        await db.updateComboJob(job.id, { status: "failed", error_msg: err.message, completed: true }).catch(() => {});
      } else {
        await db.updateComboJob(job.id, { consecutive_errors: nextCount }).catch(() => {});
      }
    }
  }
}

async function autoCloseComboProcessJob(job) {
  if (job.status === "active") {
    // If ANY leg's option has expired, escalate the whole combo to closing
    // now — waiting on an equity target a dead leg may never let it reach.
    const legs = await db.getComboJobLegs(job.id);
    for (const leg of legs) {
      if (parseFloat(leg.opt_qty || 0) === 0) continue;
      if (await deribitIsOptionExpired(leg.opt_instrument)) {
        await db.appendComboLog(job.id, `Leg ${leg.leg_index + 1} option ${leg.opt_instrument} has expired — moving the whole combo to closing.`);
        await sendTelegramAlert([
          `⏰ <b>Strike Expired</b> — Combo Job #${job.id}`,
          `Leg ${leg.leg_index + 1} (${leg.leg_type || "?"}): ${leg.opt_instrument} expired before the +$${parseFloat(job.target_pnl).toFixed(2)} target was reached.`,
          `Closing all legs now.`,
        ].join("\n"));
        await db.updateComboJob(job.id, { status: "closing", triggered: true });
        return;
      }
    }

    const col = await deribitCollateral(job.token, job.account_id);
    // Track against the COIN wallet's equity only, not coin+USDC combined —
    // the options/futures legs only ever move the coin side; folding in
    // USDC (which can drift from unrelated account activity) can mask a
    // real coin-side loss or falsely bring the target closer.
    const equity = col.coin_equity_usd;
    const pnl = equity - parseFloat(job.initial_total_usd);
    const targetPnl = parseFloat(job.target_pnl);
    await db.updateComboJob(job.id, { last_checked_at: new Date(), last_equity_usd: equity });

    if (!job.approach_alert_sent && targetPnl > 0 && pnl >= targetPnl * AC_APPROACH_THRESHOLD) {
      await db.updateComboJob(job.id, { approach_alert_sent: 1 });
      await sendTelegramAlert([
        `⚠️ <b>Combo Auto-Close Approaching Target</b> — Job #${job.id}`,
        `PnL: +$${pnl.toFixed(2)} / target +$${targetPnl.toFixed(2)} (${((pnl / targetPnl) * 100).toFixed(1)}%)`,
        `Auto-close will trigger soon — keep an eye on it.`,
      ].join("\n"));
    }

    if (equity >= parseFloat(job.target_total_usd)) {
      await db.appendComboLog(job.id,
        `TARGET HIT — ${col.coin_symbol} equity $${col.coin_equity_usd.toFixed(2)} (USDC $${col.usdc_equity.toFixed(2)} not counted) | PnL +$${pnl.toFixed(2)}`);
      await db.updateComboJob(job.id, { status: "closing", triggered: true });
    }
    return;
  }

  if (job.status === "closing") {
    const legs = await db.getComboJobLegs(job.id);
    let allDone = true;
    for (const leg of legs) {
      const optQty = parseFloat(leg.opt_qty || 0), futQty = parseFloat(leg.fut_qty || 0);
      const optDone = optQty === 0 || !!leg.opt_done;
      const futDone = futQty === 0 || !!leg.fut_done;
      if (optQty !== 0 && !optDone) { allDone = false; await autoCloseComboCloseLegOption(job.id, leg, job.account_id); continue; }
      if (futQty !== 0 && !futDone) { allDone = false; await autoCloseComboCloseLegFutures(job.id, leg, job.account_id); continue; }
      if (optQty === 0 && !leg.opt_done) await db.updateComboLeg(leg.id, { opt_done: 1 });
      if (futQty === 0 && !leg.fut_done) await db.updateComboLeg(leg.id, { fut_done: 1 });
    }
    if (allDone) {
      await db.updateComboJob(job.id, { status: "completed", completed: true });
      await autoCloseComboFinishJob(job.id);
    }
    return;
  }
}

async function autoCloseComboCloseLegOption(comboJobId, leg, accountId) {
  const optQty = parseFloat(leg.opt_qty);

  if (await deribitPositionFlat(leg.opt_instrument, accountId)) {
    let closePrice = null;
    if (leg.opt_order_id) {
      try {
        const state = await deribitPrivate("get_order_state", { order_id: leg.opt_order_id }, accountId);
        closePrice = parseFloat(state.average_price ?? state.price ?? 0) || null;
      } catch (e) { /* order no longer queryable — leave unknown */ }
    }
    await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} option position flat (${leg.opt_instrument})${closePrice != null ? ` — filled @ ${closePrice}` : " — expired/settled or closed outside the worker"}.`);
    const patch = { opt_done: 1 };
    if (closePrice != null) patch.opt_close_price = closePrice;
    await db.updateComboLeg(leg.id, patch);
    return;
  }

  if (leg.opt_order_id) {
    const state = await deribitPrivate("get_order_state", { order_id: leg.opt_order_id }, accountId);

    if (state.order_state === "filled") {
      const closePrice = parseFloat(state.average_price ?? state.price ?? 0);
      await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} option ${leg.opt_order_id} filled: ${leg.opt_instrument} @ ${closePrice}`);
      await db.updateComboLeg(leg.id, { opt_done: 1, opt_close_price: closePrice });
      return;
    }
    if (state.order_state === "cancelled" || state.order_state === "rejected") {
      await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} option order ${state.order_state} — re-placing.`);
      await db.updateComboLeg(leg.id, { opt_order_id: null });
      return;
    }

    const ticker = await deribitGet(`/api/v2/public/ticker?instrument_name=${encodeURIComponent(leg.opt_instrument)}`);
    const bid = ticker?.best_bid_price || 0, ask = ticker?.best_ask_price || 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ticker?.mark_price || 0);
    const orderPrice = parseFloat(state.price ?? 0);

    if (mid > 0 && Math.abs(mid - orderPrice) > AC_OPT_REQUOTE_THRESHOLD) {
      await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} option mid moved ${orderPrice.toFixed(5)} → ${mid.toFixed(5)}, re-quoting...`);
      try { await deribitPrivate("cancel", { order_id: leg.opt_order_id }, accountId); } catch (e) { /* already filled/cancelled */ }
      await db.updateComboLeg(leg.id, { opt_order_id: null });
      const freshLegs = await db.getComboJobLegs(comboJobId);
      const freshLeg = freshLegs.find((l) => l.id === leg.id);
      if (freshLeg) await autoCloseComboCloseLegOption(comboJobId, freshLeg, accountId);
    }
    return;
  }

  const result = await deribitPlaceLimitClose(leg.opt_instrument, optQty, leg.opt_dir, accountId);
  const orderId = result?.order?.order_id, price = result?.order?.price;
  await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} option maker close placed: ${Math.abs(optQty)}x ${leg.opt_instrument} @ ${price} [order ${orderId}]`);
  await db.updateComboLeg(leg.id, { opt_order_id: orderId });
}

async function autoCloseComboCloseLegFutures(comboJobId, leg, accountId) {
  const futQty = parseFloat(leg.fut_qty || 0);
  if (futQty === 0 || !leg.fut_instrument) { await db.updateComboLeg(leg.id, { fut_done: 1 }); return; }
  if (await deribitPositionFlat(leg.fut_instrument, accountId)) {
    await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} futures position flat (${leg.fut_instrument}) — nothing left to close.`);
    await db.updateComboLeg(leg.id, { fut_done: 1 });
    return;
  }
  const result = await deribitPlaceMarketClose(leg.fut_instrument, futQty, leg.fut_dir, accountId);
  const closePrice = parseFloat(result?.order?.average_price ?? result?.order?.price ?? 0);
  await db.appendComboLog(comboJobId, `Leg ${leg.leg_index + 1} futures market close: ${Math.abs(futQty)}x ${leg.fut_instrument} @ ${closePrice}`);
  await db.updateComboLeg(leg.id, { fut_done: 1, fut_close_price: closePrice });
}

async function autoCloseComboFinishJob(comboJobId) {
  try {
    const job = await db.getComboJobRaw(comboJobId);
    if (!job) return;
    const legs = await db.getComboJobLegs(comboJobId);
    const col = await deribitCollateral(job.token, job.account_id).catch(() => null);
    const finalEquity = col?.coin_equity_usd ?? parseFloat(job.last_equity_usd ?? job.initial_total_usd);
    await db.updateComboJob(comboJobId, { final_equity_usd: finalEquity });
    // Snapshot the combo job's own audit trail onto every leg's trade row,
    // so it survives even if this job record is later cleaned up.
    if (job.group_id) {
      const { trades } = await db.listOptionsTrades({ groupId: job.group_id }).catch(() => ({ trades: [] }));
      for (const t of trades || []) {
        await db.updateOptionsTrade(t.id, {
          execution_log: job.log_json, target_pnl: job.target_pnl, initial_collateral_usd: job.initial_total_usd,
        }).catch((e) => console.error(`[auto-close-combo #${comboJobId}] trade ${t.id} snapshot failed:`, e.message));
      }
    }
    const initial = parseFloat(job.initial_total_usd);
    const netDiff = finalEquity - initial;
    const legLines = legs.map((leg) => {
      const optEntry = leg.opt_entry_price != null ? parseFloat(leg.opt_entry_price) : null;
      const optClose = leg.opt_close_price != null ? parseFloat(leg.opt_close_price) : null;
      const futEntry = leg.fut_entry_price != null ? parseFloat(leg.fut_entry_price) : null;
      const futClose = leg.fut_close_price != null ? parseFloat(leg.fut_close_price) : null;
      const parts = [`<b>Leg ${leg.leg_index + 1}</b> (${leg.leg_type || "?"}): ${leg.opt_instrument}`];
      if (optEntry != null) parts.push(`  Opt: $${optEntry.toFixed(4)} → ${optClose != null ? "$" + optClose.toFixed(4) : "—"}`);
      if (leg.fut_instrument && futEntry != null) parts.push(`  Fut: $${futEntry.toFixed(2)} → ${futClose != null ? "$" + futClose.toFixed(2) : "—"}`);
      return parts.join("\n");
    });
    const lines = [
      `✅ <b>Combo Auto-Close Complete</b> — Job #${comboJobId}`, ``, ...legLines, ``,
      `Initial collateral: $${initial.toFixed(2)}`,
      `Final collateral: $${finalEquity.toFixed(2)}`,
      `<b>Net PnL: ${netDiff >= 0 ? "+" : ""}$${netDiff.toFixed(2)}</b>`,
    ];
    await sendTelegramAlert(lines.join("\n"));
  } catch (e) { console.error(`[auto-close-combo #${comboJobId}] finish-job alert failed:`, e.message); }
}

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
  const symbol   = req.query.symbol && req.query.symbol !== "all" ? req.query.symbol : null;
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
    const report = await db.queryReport({ exchange, fromTs, toTs, symbol });
    if (!report) return res.status(503).json({ error: "DB unavailable" });
    res.json({ period, fromTs, toTs, exchange, symbol, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trading accounts (multi-wallet) ─────────────────────────
// List never exposes private keys.
app.get("/api/accounts", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try { res.json(await db.listAccounts()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  const name     = (req.body?.name || "").trim();
  const exchange = req.body?.exchange || "hyperliquid";
  const inCreds  = req.body?.credentials || {};
  if (!name) return res.status(400).json({ error: "name is required" });

  const s = v => String(v ?? "").trim();
  let credentials;
  if (exchange === "hyperliquid") {
    const walletAddress = s(inCreds.walletAddress), privateKey = s(inCreds.privateKey);
    if (!walletAddress || !privateKey) return res.status(400).json({ error: "walletAddress and privateKey are required" });
    if (!/^0x[0-9a-fA-F]{6,}$/.test(walletAddress)) return res.status(400).json({ error: "walletAddress must be a 0x… hex address" });
    if (!/^0x[0-9a-fA-F]{40,}$/.test(privateKey))   return res.status(400).json({ error: "privateKey must be a 0x… hex key" });
    credentials = { walletAddress, privateKey };
  } else if (exchange === "binance") {
    const apiKey = s(inCreds.apiKey), secretKey = s(inCreds.secretKey);
    if (!apiKey || !secretKey) return res.status(400).json({ error: "apiKey and secretKey are required" });
    credentials = { apiKey, secretKey };
  } else if (exchange === "deribit") {
    const clientId = s(inCreds.clientId), clientSecret = s(inCreds.clientSecret);
    if (!clientId || !clientSecret) return res.status(400).json({ error: "clientId and clientSecret are required" });
    credentials = { clientId, clientSecret };
  } else {
    return res.status(400).json({ error: "Unknown exchange" });
  }

  try {
    const id = await db.addAccount({ name, exchange, credentials });
    res.json({ ok: true, id });
  } catch (e) {
    if (/Duplicate entry/i.test(e.message)) return res.status(409).json({ error: "An account with that name already exists for this exchange" });
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/accounts/:id", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  const id = parseInt(req.params.id, 10);
  try {
    if (await db.isAccountReferenced(id)) {
      return res.status(409).json({ error: "This account is referenced by an open strategy or an active auto-close job — stop/close it first." });
    }
    await db.deleteAccount(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-off auth check against Deribit itself — never touches orders/positions,
// just confirms the saved client_id/secret actually authenticate, before the
// account gets used for real execution.
app.post("/api/accounts/:id/test-auth", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  const acc = await db.getAccount(parseInt(req.params.id, 10));
  if (!acc) return res.json({ ok: false, error: "Account not found" });
  if (acc.exchange !== "deribit") return res.json({ ok: false, error: `Test Connection is only implemented for Deribit accounts (this is ${acc.exchange}).` });
  const { clientId, clientSecret } = acc.credentials || {};
  if (!clientId || !clientSecret) return res.json({ ok: false, error: "No Client ID/Secret saved for this account." });
  const host = deribitHost();
  try {
    const r = await fetch(`https://${host}/api/v2/public/auth?grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`);
    const j = await r.json();
    if (j.error) {
      return res.json({
        ok: false, error: `Deribit rejected the credentials: "${j.error.message}" (code ${j.error.code})`,
        endpoint: host, client_id_preview: clientId.slice(0, 8) + "…",
      });
    }
    return res.json({ ok: true, message: "Authentication successful!", scope: j.result?.scope, endpoint: host });
  } catch (e) {
    return res.json({ ok: false, error: `Network error: ${e.message}` });
  }
});

// ── Options Multi-Agent Database (Dashboard / Add / Simulator / Analysis) ──
app.get("/api/options-db/trades", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const result = await db.listOptionsTrades({
      status  : req.query.status,
      token   : (req.query.token || "").trim(),
      groupId : req.query.group_id,
      dateFrom: req.query.date_from,
      dateTo  : req.query.date_to,
      page    : req.query.page,
      limit   : req.query.limit,
    });
    if (!result) return res.status(503).json({ error: "DB unavailable" });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/options-db/trades/:id", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const trade = await db.getOptionsTrade(parseInt(req.params.id, 10));
    if (!trade) return res.status(404).json({ error: "Not found." });
    res.json({ trade });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/options-db/trades", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    const id = await db.addOptionsTrade(req.body || {});
    res.status(201).json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put("/api/options-db/trades/:id", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    await db.updateOptionsTrade(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
  }
});

app.delete("/api/options-db/trades/:id", async (req, res) => {
  if (!db.dbConfigured()) return res.status(503).json({ error: "MySQL not configured" });
  try {
    await db.deleteOptionsTrade(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) {
    res.status(/not found/i.test(e.message) ? 404 : 500).json({ error: e.message });
  }
});

// CSV download (browser) — same period semantics as /api/report
app.get("/api/csv", async (req, res) => {
  // No exchange param = cross-exchange (matches the PnL Report). A specific
  // exchange/botId still scopes it when provided.
  const exchangeParam = req.query.botId || req.query.exchange || null;
  if (exchangeParam && !bots[exchangeParam]) return res.status(400).json({ error: "Unknown exchange" });
  const symbol = req.query.symbol && req.query.symbol !== "all" ? req.query.symbol : null;

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

  if (exchangeParam === "deribit") await refreshDeribitFees().catch(()=>{});

  // Prefer the DB-backed builder so the CSV honours the coin filter and
  // persists across restarts. Fall back to in-memory if MySQL isn't set up.
  let csv;
  if (db.dbConfigured()) {
    try {
      const report = await db.queryReport({ exchange: exchangeParam, fromTs, toTs, symbol });
      csv = report ? buildCsvFromDbReport(report, { exchangeKey: exchangeParam || "all", symbol, fromTs, toTs })
                   : buildCsvReport(exchangeParam || "binance", fromTs, toTs);
    } catch (e) {
      csv = buildCsvReport(exchangeParam || "binance", fromTs, toTs);
    }
  } else {
    csv = buildCsvReport(exchangeParam || "binance", fromTs, toTs);
  }
  const symTag   = symbol ? `_${String(symbol).replace(/[^A-Za-z0-9]+/g, "")}` : "";
  const dateStr  = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const filename = `gridbot_${exchangeParam || "all"}${symTag}_${period}_${dateStr}.csv`;
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
  // True resume (from resumeSessions() on boot) MUST reuse the EXACT
  // original botId the session was persisted under — not get dynamically
  // reassigned to whichever slot happens to be free. Session persistence
  // (saveSessionState every 30s, clearSession on stop) is always keyed by
  // the bot's CURRENT runtime botId, not by whatever key it was originally
  // saved under. Before this, a resumed bot could land on a different slot
  // each restart (first-come-first-served on the shared legacy slot), so
  // /api/stop's clearSession(runtimeBotId) would delete the wrong row (or
  // none at all) — leaving the ORIGINAL row orphaned in bot_sessions,
  // untouched by any future save/clear, and re-resumed forever on every
  // subsequent restart even after being "stopped". Reusing the original id
  // keeps every save/clear operation pointed at the one row it came from.
  const resumeBotId = req.body?.resume === true ? req.body?._resumeBotId : null;
  let bot, botId;
  if (resumeBotId) {
    if (bots[resumeBotId]?.running) {
      return res.status(409).json({ error: `Bot ${resumeBotId} is already running` });
    }
    botId = resumeBotId;
    bot = makeFreshBot(exchangeKey, botId);
    bots[botId] = bot;
  } else {
    // First bot of an exchange (when the legacy slot is free) reuses the
    // legacy slot — keeps Binance hedge + Telegram menus working. Additional
    // bots get a fresh unique instance so many run simultaneously.
    const legacy = bots[exchangeKey];
    if (legacy && !legacy.running) {
      botId = exchangeKey;
      // refresh the legacy slot
      bots[exchangeKey] = makeFreshBot(exchangeKey, exchangeKey);
      bot = bots[exchangeKey];
    } else {
      const lbl = `${cfg.symbol || exchangeKey} ${priceSource.includes("spot") ? "Spot" : priceSource.includes("hyperliquid") ? "Perp" : ""}`.trim();
      bot = createBotInstance(exchangeKey, lbl);
      botId = bot.botId;
    }
  }
  bot.label = `${cfg.symbol || exchangeKey}`;

  injectKeysIntoCfg(exchangeKey, cfg);
  await applyAccountCreds(cfg);   // override with the selected account's keys, if any

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

  // Spacing is a distance between grid levels — must be strictly positive.
  // A negative value flips buy prices above the anchor (and sell prices
  // below it), so every computed order guarantees a spread cross and gets
  // rejected forever: the bot runs but never places a single order.
  if (!(cfg.avgSellSpacing > 0) || !(cfg.avgBuySpacing > 0)) {
    removeBotInstance(botId);
    return res.status(400).json({ error: "avgSellSpacing / avgBuySpacing must be positive numbers" });
  }

  try {
    const exchange = buildExchange(priceSource, cfg.apiKey, cfg.secretKey);
    await exchange.loadMarkets();
    if (exchangeKey === "binance") await syncExchangeTime(exchange);

    // For Hyperliquid: pre-warm the native SDK BEFORE the startup ticker,
    // because CCXT's fetchTicker is broken for Hyperliquid (consistent
    // timeouts). Once hlCache exists, getTickerSnapshot uses native l2Book.
    // If this fails (transient network error), gridLoop self-heals by calling
    // ensureHlCache again on the next tick.
    if (exchangeKey === "hyperliquid") {
      await ensureHlCache(botId, bot, cfg, exchange);
    }

    // Resume flags (needed early so a failed startup ticker can fall back to
    // saved state instead of aborting the whole resume).
    const isResume    = req.body?.resume === true;
    const resumeState = req.body?._resumeState || null;

    // Startup ticker. For Hyperliquid uses native l2Book (CCXT fetchTicker
    // is broken). Retry once if it times out.
    let tick;
    try {
      tick = await getTickerSnapshot(exchange, cfg.symbol, 15000, bot);
    } catch (e) {
      if (/timeout/i.test(e.message)) {
        log(botId, `First ticker fetch timed out, retrying once...`, "warn");
        try { tick = await getTickerSnapshot(exchange, cfg.symbol, 20000, bot); }
        catch (e2) { if (!(isResume && resumeState)) throw e2; }
      } else if (!(isResume && resumeState)) {
        throw e;
      }
    }
    if (!tick) {
      // Resume with no live price yet (e.g. Hyperliquid cache not ready due to
      // a transient prewarm failure). Use saved state and let gridLoop's
      // self-heal rebuild hlCache; live prices resume on the next tick.
      const px = resumeState?.lastPrice ?? resumeState?.entryPrice ?? 0;
      tick = { last: px, bid: px, ask: px };
      log(botId, `Startup ticker unavailable — resuming from saved price $${px}, will self-heal`, "warn");
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
    // (isResume / resumeState are declared above, before the startup ticker.)
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
      // If the market drifted OUTSIDE the saved band during downtime, re-center
      // the band on the current price so the bot resumes and keeps trading
      // instead of instantly emergency-stopping on the next tick. Normal
      // deploys (price still inside the band) keep the saved band untouched.
      const curPx = tick.last;
      if (curPx && (curPx >= upperLimit || curPx <= lowerLimit)) {
        entryPrice = curPx;
        upperLimit = parseFloat((curPx + cfg.distance).toFixed(8));
        lowerLimit = parseFloat((curPx - cfg.distance).toFixed(8));
        bot.gridAnchor = null;   // force a fresh grid re-anchor around the new center
        log(botId, `Market $${curPx} drifted outside the saved band — re-centered to $${lowerLimit}–$${upperLimit} on resume (was breaching, would have stopped)`, "warn");
      }
      if (resumeState.lastNotifiedRt != null) bot.lastNotifiedRt = resumeState.lastNotifiedRt;
      // Runtime should reflect actual UPTIME, not wall-clock since first start.
      // Shift the start forward by the downtime (≈ time since the last state
      // save) on each resume, so crash/outage/deploy gaps don't inflate it.
      // This accumulates correctly across repeated restarts (e.g. a crash loop).
      if (resumeState.startedAt != null) {
        const savedAtMs = resumeState.savedAt ? new Date(resumeState.savedAt).getTime() : Date.now();
        const downMs    = Math.max(0, Date.now() - savedAtMs);
        bot.startedAt   = resumeState.startedAt + downMs;
      }
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
  db.pingDb().then(ok => {
    if (ok) {
      seedEnvAccounts();
      resumeSessions();
      startAutoCloseWorker();
      startAutoCloseComboWorker();
    }
  });
});

// Seed a default account per exchange from the .env keys (HYPE-MAIN /
// BINANCE-MAIN / DERIBIT-MAIN) so the dashboard's account dropdown works out
// of the box. Idempotent — skips any that already exist or lack env keys.
async function seedEnvAccounts() {
  const defaults = [
    { name: "HYPE-MAIN", exchange: "hyperliquid",
      credentials: { walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS, privateKey: process.env.HYPERLIQUID_PRIVATE_KEY } },
    { name: "BINANCE-MAIN", exchange: "binance",
      credentials: { apiKey: process.env.BINANCE_API_KEY, secretKey: process.env.BINANCE_SECRET_KEY } },
    { name: "DERIBIT-MAIN", exchange: "deribit",
      credentials: { clientId: process.env.DERIBIT_CLIENT_ID, clientSecret: process.env.DERIBIT_CLIENT_SECRET } },
  ];
  let existing;
  try { existing = await db.listAccounts(); } catch (e) { return; }
  const have = new Set((existing || []).map(a => `${a.exchange}:${a.name}`));
  for (const d of defaults) {
    if (Object.values(d.credentials).some(v => !v)) continue;   // env keys missing
    if (have.has(`${d.exchange}:${d.name}`)) continue;          // already seeded
    try { await db.addAccount(d); console.log(`[ACCOUNTS] Seeded ${d.name} (${d.exchange}) from .env`); }
    catch (e) { if (!/Duplicate entry/i.test(e.message)) console.error("[ACCOUNTS] seed failed:", e.message); }
  }
}

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
      // True continuation: pass resume:true + the persisted state, AND the
      // exact original botId (_resumeBotId) so /api/start reuses that same
      // slot instead of dynamically assigning a new one — keeps this row
      // the one every future save/clear targets, instead of orphaning it.
      const r = await fetch(`http://127.0.0.1:${PORT}/api/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...s.config, resume: true, _resumeState: s.state, _resumeBotId: s.botId }),
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
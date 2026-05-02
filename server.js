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

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================================
//  MULTI-BOT STATE
//  Each exchange has its own isolated bot instance.
//  bots.binance and bots.deribit can run independently.
// ============================================================
function makeFreshBot(exchangeKey) {
  return {
    exchangeKey,
    running             : false,
    config              : null,
    exchange            : null,
    openOrders          : [],
    entryPrice          : null,
    lastPrice           : null,
    upperLimit          : null,
    lowerLimit          : null,
    fillHistory         : [],
    pendingRoundTrips   : [],
    completedRoundTrips : [],
    logs                : [],
    loopTimer           : null,
    loopCount           : 0,
    lastNotifiedRt      : 0,
    stats               : null,
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

const bots = {
  binance : makeFreshBot("binance"),
  deribit : makeFreshBot("deribit"),
};

const EXCHANGE_TAG = {
  binance : "🟦 Binance",
  deribit : "🟧 Deribit",
};

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

// ── Telegram menus ──────────────────────────────────────────
function exchangeSelectorMenu(action) {
  return [
    [
      {text:`🟦 Binance ${bots.binance.running?"🟢":"🔴"}`, callback_data:`pick_binance_${action}`},
      {text:`🟧 Deribit ${bots.deribit.running?"🟢":"🔴"}`, callback_data:`pick_deribit_${action}`},
    ],
    [{text:"⬅ Back to Menu", callback_data:"main_menu"}],
  ];
}

function mainMenu() {
  return [
    [{text:"📊 Status",      callback_data:"act_status"   },{text:"💼 Portfolio",  callback_data:"act_portfolio"}],
    [{text:"🔄 Restart Bot", callback_data:"act_restart"  },{text:"⏹ Stop Bot",   callback_data:"act_stop"     }],
    [{text:"📈 PnL Report",  callback_data:"act_report"   },{text:"❓ Help",       callback_data:"act_help"     }],
  ];
}

function exchangeMenu(exchangeKey) {
  const e = exchangeKey;
  const tag = EXCHANGE_TAG[e];
  return [
    [{text:`📊 ${tag} Status`, callback_data:`do_status_${e}`}, {text:`💼 Portfolio`, callback_data:`do_portfolio_${e}`}],
    [{text:`🔄 Restart`, callback_data:`do_restart_${e}`}, {text:`⏹ Stop`, callback_data:`do_stop_${e}`}],
    [{text:`📈 PnL Report`, callback_data:`do_report_${e}`}],
    [{text:"⬅ Back", callback_data:"main_menu"}],
  ];
}

function tgStatusText(exchangeKey) {
  const s   = bots[exchangeKey];
  const tag = EXCHANGE_TAG[exchangeKey];
  const cfg = s.config;
  if (!s.running) return `<b>${tag} — 🔴 STOPPED</b>\n\nBot is not running.\nTap 🔄 Restart to bring it back.`;
  const st = s.stats || {};
  return `<b>${tag} — 🟢 RUNNING</b>

📌 <b>Symbol :</b> <code>${cfg?.symbol||"—"}</code>
💵 <b>Price  :</b> <code>$${(s.lastPrice||0).toFixed(4)}</code>
🎯 <b>Entry  :</b> <code>$${(s.entryPrice||0).toFixed(4)}</code>
🔼 <b>Upper  :</b> <code>$${(s.upperLimit||0).toFixed(4)}</code>
🔽 <b>Lower  :</b> <code>$${(s.lowerLimit||0).toFixed(4)}</code>

📦 <b>Open Orders :</b> <code>${s.openOrders.length}</code>
✅ <b>Round Trips :</b> <code>${st.totalRoundTrips||0}</code>
💰 <b>Live PnL    :</b> <code>$${(st.totalPnl||0).toFixed(4)}</code>
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
/restart    Restart with new params
/stop       Stop a bot

<b>Restart — send 5 numbers:</b>
<code>sellSpread  buySpread  targetSpread  qty  distance</code>

Example: <code>1.0  1.0  0.5  0.1  10</code>

After picking an action, you'll be asked which exchange.`;
}

function restartPromptText(exchangeKey, lastCfg) {
  const tag = EXCHANGE_TAG[exchangeKey];
  const hint = lastCfg
    ? `\n📌 <b>Last used:</b>\n<code>${lastCfg.avgSellSpacing}  ${lastCfg.avgBuySpacing}  ${lastCfg.targetSpread}  ${lastCfg.qtyPerStep}  ${lastCfg.distance}</code>\n`
    : "";
  return `🔄 <b>Restart ${tag}</b>${hint}
Send <b>5 numbers</b> separated by spaces:

<code>sellSpread  buySpread  targetSpread  qty  distance</code>

Example: <code>1.0  1.0  0.5  0.1  10</code>`;
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
${feesSection}Buys    : <code>${r.periodBuys}</code>   Sells: <code>${r.periodSells}</code>`;
}

// ============================================================
//  BINANCE PORTFOLIO HELPERS (preserved from original)
// ============================================================
let _portfolioTsOffset = 0;
let _portfolioTsLastFetch = 0;
async function getPortfolioTsOffset() {
  const now = Date.now();
  if (now - _portfolioTsLastFetch < 60_000) return _portfolioTsOffset;
  try {
    const serverTime = await new Promise((resolve, reject) => {
      https.get({ host:"api.binance.com", path:"/api/v3/time", headers:{"User-Agent":"node"} }, (res) => {
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
  return new Promise((resolve, reject) => {
    const q=`timestamp=${ts}&recvWindow=60000`;
    const sig=crypto.createHmac("sha256",secretKey).update(q).digest("hex");
    https.get({host:"fapi.binance.com",path:`${path}?${q}&signature=${sig}`,headers:{"X-MBX-APIKEY":apiKey,"User-Agent":"node"}},
      (res)=>{let raw="";res.on("data",c=>raw+=c);res.on("end",()=>{try{resolve(JSON.parse(raw))}catch(e){reject(new Error(raw.slice(0,200)))}});
    }).on("error",reject);
  });
}

function dapiSignedRequest(path, apiKey, secretKey, tsOverride) {
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

// ============================================================
//  RESTART HANDLER (per exchange)
// ============================================================
async function tgDoRestart(chatId, exchangeKey, sellSpread, buySpread, targetSpread, qty, distance) {
  const bot = bots[exchangeKey];
  const tag = EXCHANGE_TAG[exchangeKey];
  const prev = bot.config;
  if (!prev) {
    await tgSend(chatId, `❌ ${tag}: No previous config. Start from web UI first.`, mainMenu());
    return;
  }
  await tgSend(chatId,
    `⏳ Restarting ${tag}...\n\nSell : <code>$${sellSpread}</code>\nBuy  : <code>$${buySpread}</code>\nTarget: <code>$${targetSpread}</code>\nQty   : <code>${qty}</code>\nDist  : <code>$${distance}</code>`
  );

  if (bot.running) {
    clearInterval(bot.loopTimer); bot.running = false;
    try{ await cancelAllOrders(exchangeKey); } catch(e){}
    log(exchangeKey, "Telegram restart: stopped previous session", "warn");
  }

  const cfg = {
    ...prev,
    avgSellSpacing : sellSpread,
    avgBuySpacing  : buySpread,
    targetSpread,
    qtyPerStep     : qty,
    distance,
  };
  injectKeysIntoCfg(exchangeKey, cfg);

  try {
    const exchange = buildExchange(cfg.priceSource, cfg.apiKey, cfg.secretKey);
    await exchange.loadMarkets();
    if (exchangeKey === "binance") await syncExchangeTime(exchange);

    const entryPrice = await getCurrentPrice(exchange, cfg.symbol);
    const upperLimit = parseFloat((entryPrice + cfg.distance).toFixed(8));
    const lowerLimit = parseFloat((entryPrice - cfg.distance).toFixed(8));

    Object.assign(bot, {
      config: cfg, exchange, entryPrice, lastPrice: entryPrice,
      upperLimit, lowerLimit, running: true, openOrders: [],
      fillHistory: [], pendingRoundTrips: [], completedRoundTrips: [],
      logs: [], loopCount: 0, lastNotifiedRt: 0,
    });

    try { await exchange.cancelAllOrders(cfg.symbol); }
    catch(e) {
      try {
        const p2 = await exchange.fetchOpenOrders(cfg.symbol);
        for (const o of p2) { try{ await exchange.cancelOrder(o.id, cfg.symbol); }catch(_){} }
      } catch(_){}
    }

    await maintainGrid(exchangeKey, entryPrice);
    bot.loopTimer = setInterval(() => gridLoop(exchangeKey), 5000);
    log(exchangeKey, `Telegram restart: RUNNING | Entry $${entryPrice} | ${cfg.symbol}`, "success");
    broadcast("state", buildStateSnapshot());

    await tgSend(chatId,
      `✅ <b>${tag} Restarted!</b>\n\nSymbol: <code>${cfg.symbol}</code>\nEntry : <code>$${entryPrice.toFixed(4)}</code>\nUpper : <code>$${upperLimit.toFixed(4)}</code>\nLower : <code>$${lowerLimit.toFixed(4)}</code>\nRange : <code>±$${distance}</code>`,
      mainMenu()
    );
  } catch(err) {
    log(exchangeKey, `Telegram restart failed: ${err.message}`, "error");
    await tgSend(chatId, `❌ ${tag} Restart failed:\n<code>${err.message}</code>`, mainMenu());
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
      const parts = text.split(/\s+/).map(Number);
      if (parts.length !== 5 || parts.some(isNaN) || parts.some(v => v <= 0)) {
        await tgSend(fromId,
          `❌ Need exactly <b>5 positive numbers</b>:\n<code>sellSpread  buySpread  targetSpread  qty  distance</code>\n\nExample: <code>1.0  1.0  0.5  0.1  10</code>`,
          [[{text:"❌ Cancel", callback_data:"cancel_restart"}]]);
        return;
      }
      const exch = conv.exchangeKey;
      delete tgConv[fromId];
      const [ss, bs, ts, q, dist] = parts;
      await tgDoRestart(fromId, exch, ss, bs, ts, q, dist);
      return;
    }

    const cmd = text.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/menu":
        await tgSend(fromId,
          `👋 <b>Grid Bot Control Panel</b>\n\n🟦 Binance: <b>${bots.binance.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n🟧 Deribit: <b>${bots.deribit.running?"🟢 RUNNING":"🔴 STOPPED"}</b>\n\nChoose an action:`,
          mainMenu()); break;
      case "/status":    await tgSend(fromId, "Pick an exchange:", exchangeSelectorMenu("status")); break;
      case "/portfolio": await tgSend(fromId, "Pick an exchange:", exchangeSelectorMenu("portfolio")); break;
      case "/report":    await tgSend(fromId, "Pick an exchange:", exchangeSelectorMenu("report")); break;
      case "/restart":   await tgSend(fromId, "Pick an exchange to restart:", exchangeSelectorMenu("restart")); break;
      case "/stop":      await tgSend(fromId, "Pick an exchange to stop:", exchangeSelectorMenu("stop")); break;
      case "/help":      await tgSend(fromId, tgHelpText(), mainMenu()); break;
      default:
        if (!conv) await tgSend(fromId, "Use /menu or tap the buttons:", mainMenu());
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
      const txt = exchangeKey === "binance" ? await tgBinancePortfolioText() : await tgDeribitPortfolioText();
      await tgEdit(chatId, msgId, txt, exchangeMenu(exchangeKey));
      return;
    }
    case "report":
      await tgEdit(chatId, msgId, "⏳ Computing report...", null);
      if (exchangeKey === "deribit") await refreshDeribitFees().catch(()=>{});
      await tgEdit(chatId, msgId, tgReportText(exchangeKey), exchangeMenu(exchangeKey));
      return;
    case "stop":
      if (!bot.running) {
        await tgEdit(chatId, msgId, `ℹ️ ${tag} is already stopped.`, exchangeMenu(exchangeKey));
        return;
      }
      clearInterval(bot.loopTimer); bot.running = false;
      try { await cancelAllOrders(exchangeKey); } catch(e){}
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

function log(exchangeKey, msg, level = "info") {
  const tag = EXCHANGE_TAG[exchangeKey] || exchangeKey;
  const entry = { exchangeKey, msg: `[${tag}] ${msg}`, level, ts: new Date().toISOString() };
  bots[exchangeKey].logs.unshift(entry);
  if (bots[exchangeKey].logs.length > 200) bots[exchangeKey].logs.pop();
  broadcast("log", entry);
  console.log(`[${exchangeKey.toUpperCase()}/${level.toUpperCase()}] ${msg}`);
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

  if (priceSource === "binance_futures") {
    return stripCurrencies(new ccxt.binanceusdm({ ...baseCreds, options:{...baseCreds.options, defaultType:"future"} }));
  }
  if (priceSource === "binance_coinm") {
    return stripCurrencies(new ccxt.binancecoinm({ ...baseCreds, options:{...baseCreds.options, defaultType:"delivery"} }));
  }
  if (priceSource === "deribit" || priceSource === "deribit_spot") {
    const isSpot = priceSource === "deribit_spot";
    const ex = new ccxt.deribit({
      apiKey, secret: secretKey,
      options: { defaultType: isSpot ? "spot" : "swap" },
    });
    // ── Testnet support ──────────────────────────────────────
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
  return stripCurrencies(new ccxt.binance(baseCreds));
}

function injectKeysIntoCfg(exchangeKey, cfg) {
  if (exchangeKey === "deribit") {
    cfg.apiKey    = process.env.DERIBIT_CLIENT_ID;
    cfg.secretKey = process.env.DERIBIT_CLIENT_SECRET;
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
    const serverTime = await new Promise((resolve, reject) => {
      https.get({host:"api.binance.com", path, headers:{"User-Agent":"node"}}, (res) => {
        let raw=""; res.on("data",c=>raw+=c);
        res.on("end",()=>{ try{resolve(JSON.parse(raw).serverTime)}catch(e){reject(e)} });
      }).on("error", reject);
    });
    const offset = serverTime - Date.now();
    exchange.timeDifference = offset;
    exchange.options.timeDifference = offset;
    exchange.nonce = () => Date.now() + offset;
    exchange.milliseconds = () => Date.now() + offset;
    console.log(`[TIME SYNC] ${exchange.id} offset=${offset}ms`);
  } catch (err) {
    console.warn("[TIME SYNC] Failed:", err.message);
  }
}

async function getCurrentPrice(exchange, symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last;
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
async function emergencyStop(exchangeKey, reason) {
  const bot = bots[exchangeKey];
  if (!bot.running) return;
  clearInterval(bot.loopTimer);
  bot.running = false;
  log(exchangeKey, `EMERGENCY STOP: ${reason}`, "error");
  try { await cancelAllOrders(exchangeKey); } catch(e){}

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
async function gridLoop(exchangeKey) {
  const bot = bots[exchangeKey];
  if (!bot.running) return;
  try {
    const currentPrice = await getCurrentPrice(bot.exchange, bot.config.symbol);
    bot.lastPrice = currentPrice;

    if (currentPrice >= bot.upperLimit) {
      await emergencyStop(exchangeKey, `Price $${currentPrice} reached UPPER LIMIT $${bot.upperLimit}`);
      return;
    }
    if (currentPrice <= bot.lowerLimit) {
      await emergencyStop(exchangeKey, `Price $${currentPrice} reached LOWER LIMIT $${bot.lowerLimit}`);
      return;
    }

    await checkAndHandleFills(exchangeKey, currentPrice);

    bot.loopCount = (bot.loopCount || 0) + 1;
    if (bot.loopCount % 5 === 0) await syncOrdersFromExchange(exchangeKey);

    await maintainGrid(exchangeKey, currentPrice);

    const cfg2  = bot.config;
    const fills = bot.fillHistory;
    const buys  = fills.filter(f => f.side === "buy").length;
    const sells = fills.filter(f => f.side === "sell").length;
    const currRt = Math.min(buys, sells);
    if (currRt > (bot.lastNotifiedRt || 0) && cfg2?.telegramToken && cfg2?.telegramChatId) {
      const tsp      = cfg2.targetSpread || 0;
      const qty      = cfg2.qtyPerStep   || 0;
      const totalPnl = parseFloat((currRt * tsp * qty).toFixed(4));
      const perRtPnl = parseFloat((tsp * qty).toFixed(4));
      const tag      = EXCHANGE_TAG[exchangeKey];
      await sendTelegram(cfg2.telegramToken, cfg2.telegramChatId,
        `${tag} ✅ Round Trip #${currRt}!
Symbol: ${cfg2.symbol}
Price: $${currentPrice.toFixed(4)}
PnL this RT: +$${perRtPnl}
Total PnL: +$${totalPnl}
Buys: ${buys}  Sells: ${sells}`
      );
      bot.lastNotifiedRt = currRt;
      log(exchangeKey, `📲 Telegram RT #${currRt}  PnL: +$${totalPnl}`);
    }

    broadcast("state", buildStateSnapshot());
  } catch (err) {
    log(exchangeKey, `Loop error: ${err.message}`, "error");
  }
}

// ============================================================
//  CHECK FILLS
// ============================================================
async function checkAndHandleFills(exchangeKey, currentPrice) {
  const bot = bots[exchangeKey];
  const cfg = bot.config;
  if (bot.openOrders.length === 0) return;

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

        log(exchangeKey, `FILLED [${tracked.type.toUpperCase()}] ${tracked.side.toUpperCase()} @ $${fillPrice}  qty:${fillQty}`, "success");

        bot.fillHistory.unshift({
          side: tracked.side, price: fillPrice, qty: fillQty,
          type: tracked.type, ts: fillTs,
          fee: feeCost, feeCcy, orderId: tracked.id,
        });

        if (tracked.type === "entry") {
          const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol);
          const targetSide  = tracked.side === "sell" ? "buy" : "sell";
          const targetPrice = tracked.side === "sell"
            ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
            : roundPrice(fillPrice + cfg.targetSpread, tickSize);

          const rtKey = `${tracked.side}_${fillPrice.toFixed(6)}`;
          const alreadyPending = bot.pendingRoundTrips.some(rt => rt.rtKey === rtKey);
          if (!alreadyPending) {
            bot.pendingRoundTrips.push({
              rtKey, id:`rt_${Date.now()}`,
              openSide: tracked.side, openPrice: fillPrice,
              targetSide, targetPrice, qty: fillQty, openTs: fillTs,
            });
            log(exchangeKey, `Pending RT [${rtKey}]: target ${targetSide.toUpperCase()} @ $${targetPrice}`);
          }

          await placeTargetOrder(exchangeKey, tracked.side, fillPrice, fillQty);

        } else if (tracked.type === "target") {
          const { tickSize } = await getMarketInfo(bot.exchange, cfg.symbol);
          const entrySide  = tracked.side === "buy" ? "sell" : "buy";
          const entryPrice = tracked.side === "buy"
            ? roundPrice(fillPrice + cfg.targetSpread, tickSize)
            : roundPrice(fillPrice - cfg.targetSpread, tickSize);
          const rtKey = `${entrySide}_${entryPrice.toFixed(6)}`;

          const idx = bot.pendingRoundTrips.findIndex(rt => rt.rtKey === rtKey);
          if (idx !== -1) {
            const rt        = bot.pendingRoundTrips.splice(idx, 1)[0];
            const buyPrice  = rt.openSide === "buy"  ? rt.openPrice : fillPrice;
            const sellPrice = rt.openSide === "sell" ? rt.openPrice : fillPrice;
            const pnl       = parseFloat(((sellPrice - buyPrice) * rt.qty).toFixed(8));

            bot.completedRoundTrips.unshift({
              id: rt.id, openSide: rt.openSide,
              openPrice: rt.openPrice, closePrice: fillPrice,
              qty: rt.qty, pnl,
              openTs: rt.openTs, closeTs: fillTs,
              durationMs: Date.now() - new Date(rt.openTs).getTime(),
            });
            log(exchangeKey, `✅ ROUND TRIP  Buy@$${buyPrice.toFixed(4)} Sell@$${sellPrice.toFixed(4)}  PnL:$${pnl.toFixed(4)}`, "success");

            if (cfg?.telegramToken && cfg?.telegramChatId) {
              const tag = EXCHANGE_TAG[exchangeKey];
              sendTelegram(cfg.telegramToken, cfg.telegramChatId,
                `${tag} ✅ Round Trip\nSymbol: ${cfg.symbol}\nBuy: $${buyPrice.toFixed(4)}\nSell: $${sellPrice.toFixed(4)}\nPnL: $${pnl.toFixed(4)}`
              );
            }
          } else {
            log(exchangeKey, `Target ${tracked.side.toUpperCase()} @ $${fillPrice} filled — RT key [${rtKey}] not found`, "warn");
          }
        }

      } else if (order.status === "open" || order.status === "partially_filled") {
        stillOpen.push(tracked);
      }
    } catch (err) {
      log(exchangeKey, `fetchOrder error (${tracked.id}): ${err.message}`, "warn");
      stillOpen.push(tracked);
    }
  }

  bot.openOrders = stillOpen;
}

// ============================================================
//  PLACE TARGET ORDER
// ============================================================
async function placeTargetOrder(exchangeKey, filledSide, fillPrice, fillQty) {
  const bot = bots[exchangeKey];
  const cfg = bot.config;
  const { tickSize, stepSize } = await getMarketInfo(bot.exchange, cfg.symbol);

  const targetSide  = filledSide === "sell" ? "buy" : "sell";
  const targetPrice = filledSide === "sell"
    ? roundPrice(fillPrice - cfg.targetSpread, tickSize)
    : roundPrice(fillPrice + cfg.targetSpread, tickSize);
  const qty = roundQty(fillQty, stepSize);

  const existing = bot.openOrders.find(o => o.side === targetSide && Math.abs(o.price - targetPrice) < 0.000001);
  if (existing) {
    log(exchangeKey, `Target ${targetSide.toUpperCase()} @ $${targetPrice} already on exchange`);
    return;
  }

  const sideOrders = bot.openOrders.filter(o => o.side === targetSide);
  if (sideOrders.length >= 3) {
    const victim = sideOrders.filter(o => o.type === "entry")
      .sort((a,b) => Math.abs(b.price - fillPrice) - Math.abs(a.price - fillPrice))[0];
    if (victim) {
      try {
        await bot.exchange.cancelOrder(victim.id, cfg.symbol);
        bot.openOrders = bot.openOrders.filter(o => o.id !== victim.id);
        log(exchangeKey, `Removed ENTRY ${victim.side.toUpperCase()} @ $${victim.price} — making room for target`);
      } catch (err) { log(exchangeKey, `Could not remove entry: ${err.message}`, "warn"); }
    }
  }

  try {
    // Deribit: post_only to capture maker rebates
    const params = exchangeKey === "deribit" ? { post_only: true } : {};
    const order = await bot.exchange.createLimitOrder(cfg.symbol, targetSide, qty, targetPrice, params);
    bot.openOrders.push({ id: order.id, side: targetSide, price: targetPrice, qty, type: "target" });
    log(exchangeKey, `Target ${targetSide.toUpperCase()} placed @ $${targetPrice}`);
  } catch (err) {
    log(exchangeKey, `Target placement failed @ $${targetPrice}: ${err.message}`, "error");
  }
}

// ============================================================
//  MAINTAIN GRID
// ============================================================
async function maintainGrid(exchangeKey, currentPrice) {
  const bot = bots[exchangeKey];
  const cfg = bot.config;
  const { tickSize, stepSize } = await getMarketInfo(bot.exchange, cfg.symbol);
  const qty = roundQty(cfg.qtyPerStep, stepSize);

  const staleTargetDist = cfg.avgSellSpacing * 3;
  const keepOrders = [];
  for (const o of bot.openOrders) {
    let shouldCancel = false, reason = "";
    if (o.type === "entry") {
      if (o.side === "sell" && o.price <= currentPrice) { shouldCancel = true; reason = "wrong-side (sell below price)"; }
      if (o.side === "buy"  && o.price >= currentPrice) { shouldCancel = true; reason = "wrong-side (buy above price)"; }
    } else {
      const dist = Math.abs(o.price - currentPrice);
      if (dist > staleTargetDist) { shouldCancel = true; reason = `stuck $${dist.toFixed(4)} from price`; }
    }
    if (shouldCancel) {
      try {
        await bot.exchange.cancelOrder(o.id, cfg.symbol);
        log(exchangeKey, `Cancelled ${o.type.toUpperCase()} ${o.side.toUpperCase()} @ $${o.price} — ${reason}`);
      } catch (err) {
        log(exchangeKey, `Cancel failed (${o.id}): ${err.message}`, "warn");
        keepOrders.push(o);
      }
    } else { keepOrders.push(o); }
  }
  bot.openOrders = keepOrders;

  const sellSideCount = bot.openOrders.filter(o => o.price > currentPrice).length;
  const buySideCount  = bot.openOrders.filter(o => o.price < currentPrice).length;
  const sellNeeded = Math.max(0, 3 - sellSideCount);
  const buyNeeded  = Math.max(0, 3 - buySideCount);

  if (sellNeeded === 0 && buyNeeded === 0) {
    log(exchangeKey, `Grid full: ${bot.openOrders.length} total`);
    return;
  }

  const spacing      = cfg.avgSellSpacing;
  const snappedPrice = roundPrice(Math.round(currentPrice / spacing) * spacing, tickSize);
  const occupiedEntryPrices = new Set(bot.openOrders.filter(o => o.type === "entry").map(o => o.price));
  const orderParams = exchangeKey === "deribit" ? { post_only: true } : {};

  if (sellNeeded > 0) {
    let placed = 0, step = 1;
    while (placed < sellNeeded && step <= 20) {
      const price = roundPrice(snappedPrice + step * cfg.avgSellSpacing, tickSize);
      step++;
      if (price <= currentPrice)         continue;
      if (price > bot.upperLimit)        continue;
      if (occupiedEntryPrices.has(price)) continue;
      try {
        const order = await bot.exchange.createLimitOrder(cfg.symbol, "sell", qty, price, orderParams);
        log(exchangeKey, `Entry SELL @ $${price}  [${sellSideCount + placed + 1}/3]`);
        bot.openOrders.push({ id: order.id, side: "sell", price, qty, type: "entry" });
        occupiedEntryPrices.add(price); placed++;
      } catch (err) { log(exchangeKey, `Entry SELL failed @ $${price}: ${err.message}`, "error"); }
    }
  }

  if (buyNeeded > 0) {
    let placed = 0, step = 1;
    while (placed < buyNeeded && step <= 20) {
      const price = roundPrice(snappedPrice - step * cfg.avgBuySpacing, tickSize);
      step++;
      if (price >= currentPrice)         continue;
      if (price < bot.lowerLimit)        continue;
      if (occupiedEntryPrices.has(price)) continue;
      try {
        const order = await bot.exchange.createLimitOrder(cfg.symbol, "buy", qty, price, orderParams);
        log(exchangeKey, `Entry BUY  @ $${price}  [${buySideCount + placed + 1}/3]`);
        bot.openOrders.push({ id: order.id, side: "buy", price, qty, type: "entry" });
        occupiedEntryPrices.add(price); placed++;
      } catch (err) { log(exchangeKey, `Entry BUY failed @ $${price}: ${err.message}`, "error"); }
    }
  }
}

// ============================================================
//  CANCEL ALL + SYNC
// ============================================================
async function cancelAllOrders(exchangeKey) {
  const bot = bots[exchangeKey];
  const cfg = bot.config;
  if (!bot.exchange || !cfg) return;

  try {
    await bot.exchange.cancelAllOrders(cfg.symbol);
    log(exchangeKey, `All orders cancelled (bulk)`, "success");
    bot.openOrders = [];
    return;
  } catch (err) {
    log(exchangeKey, `Bulk cancel failed: ${err.message} — falling back`, "warn");
  }

  try {
    const all = await bot.exchange.fetchOpenOrders(cfg.symbol);
    for (const o of all) {
      try { await bot.exchange.cancelOrder(o.id, cfg.symbol); } catch(e){}
    }
  } catch (err) {
    for (const o of bot.openOrders) {
      try { await bot.exchange.cancelOrder(o.id, cfg.symbol); } catch(e){}
    }
  }
  bot.openOrders = [];
}

async function syncOrdersFromExchange(exchangeKey) {
  const bot = bots[exchangeKey];
  const cfg = bot.config;
  try {
    const exchangeOrders = await bot.exchange.fetchOpenOrders(cfg.symbol);
    const exchangeIds    = new Set(exchangeOrders.map(o => o.id));
    const trackedIds     = new Set(bot.openOrders.map(o => o.id));

    const orphans = exchangeOrders.filter(o => !trackedIds.has(o.id));
    if (orphans.length > 0) {
      log(exchangeKey, `Found ${orphans.length} orphan orders — cancelling`, "warn");
      for (const o of orphans) {
        try { await bot.exchange.cancelOrder(o.id, cfg.symbol); } catch(e){}
      }
    }
    bot.openOrders = bot.openOrders.filter(o => exchangeIds.has(o.id));
  } catch (err) {
    log(exchangeKey, `sync failed: ${err.message}`, "warn");
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

  const rt  = Math.min(buys.length, sells.length);
  const qty = bot.config?.qtyPerStep    || 0;
  const tsp = bot.config?.targetSpread  || 0;
  const simplePnl = parseFloat((rt * tsp * qty).toFixed(4));

  let totalFees = 0;
  for (const f of fills) totalFees += (f.fee || 0);

  return {
    totalPnl       : simplePnl,
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
  const perRtPnl  = parseFloat((tsp * qty).toFixed(6));
  const tolerance = tsp * 0.10;

  const periodFills = bot.fillHistory.filter(f => {
    const t = new Date(f.ts).getTime();
    return t >= fromTs && t <= toTs;
  });

  const periodBuys  = periodFills.filter(f => f.side === "buy").length;
  const periodSells = periodFills.filter(f => f.side === "sell").length;

  const usedBuyIdx = new Set(), usedSellIdx = new Set(), rows = [];
  const buyFills  = periodFills.filter(f => f.side === "buy") .sort((a,b) => new Date(a.ts)-new Date(b.ts));
  const sellFills = periodFills.filter(f => f.side === "sell").sort((a,b) => new Date(a.ts)-new Date(b.ts));

  for (let bi = 0; bi < buyFills.length; bi++) {
    if (usedBuyIdx.has(bi)) continue;
    const b = buyFills[bi];
    for (let si = 0; si < sellFills.length; si++) {
      if (usedSellIdx.has(si)) continue;
      const s = sellFills[si];
      const diff = s.price - b.price;
      if (Math.abs(diff - tsp) <= tolerance && new Date(s.ts) >= new Date(b.ts)) {
        usedBuyIdx.add(bi); usedSellIdx.add(si);
        rows.push({
          openSide:"BUY", buyPrice:b.price, sellPrice:s.price, qty,
          pnl:perRtPnl, openTs:b.ts, closeTs:s.ts,
          durationMs:new Date(s.ts)-new Date(b.ts),
        });
        break;
      }
    }
  }

  for (let si = 0; si < sellFills.length; si++) {
    if (usedSellIdx.has(si)) continue;
    const s = sellFills[si];
    for (let bi = 0; bi < buyFills.length; bi++) {
      if (usedBuyIdx.has(bi)) continue;
      const b = buyFills[bi];
      const diff = s.price - b.price;
      if (Math.abs(diff - tsp) <= tolerance && new Date(b.ts) >= new Date(s.ts)) {
        usedSellIdx.add(si); usedBuyIdx.add(bi);
        rows.push({
          openSide:"SELL", buyPrice:b.price, sellPrice:s.price, qty,
          pnl:perRtPnl, openTs:s.ts, closeTs:b.ts,
          durationMs:new Date(b.ts)-new Date(s.ts),
        });
        break;
      }
    }
  }

  rows.sort((a,b) => new Date(b.closeTs) - new Date(a.closeTs));
  const rt  = rows.length;
  const pnl = parseFloat((rt * perRtPnl).toFixed(4));

  // Fees / rebates breakdown (Deribit-style, but works for any exchange that reports fees)
  let totalFees = 0, totalRebates = 0, netPnl = pnl;
  for (const f of periodFills) {
    const fee = f.fee || 0;
    if (fee > 0) totalFees += fee;
    else         totalRebates += -fee;
  }
  netPnl = parseFloat((pnl - totalFees + totalRebates).toFixed(6));

  return {
    count: rt, pnl,
    wins: rt, losses: 0,
    winRate: rt > 0 ? 100 : 0,
    roundTrips: rows,
    periodBuys, periodSells, perRtPnl,
    totalFees   : parseFloat(totalFees.toFixed(6)),
    totalRebates: parseFloat(totalRebates.toFixed(6)),
    netPnl,
  };
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
      running             : b.running,
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
      hedge               : key === "binance" ? {
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

// Server-side config flags the frontend needs to know about
app.get("/api/config", (req, res) => {
  res.json({
    deribitTestnet: String(process.env.DERIBIT_TESTNET || "").toLowerCase() === "true",
  });
});

app.get("/api/report", async (req, res) => {
  const exchangeKey = req.query.exchange || "binance";
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

app.get("/api/logs", (req, res) => {
  const exchangeKey = req.query.exchange;
  if (exchangeKey && bots[exchangeKey]) return res.json(bots[exchangeKey].logs);
  const all = [...bots.binance.logs, ...bots.deribit.logs];
  all.sort((a,b) => new Date(b.ts) - new Date(a.ts));
  res.json(all.slice(0, 200));
});

app.post("/api/start", async (req, res) => {
  const cfg = req.body;
  const priceSource = cfg.priceSource;
  // Both "deribit" (perpetual) and "deribit_spot" map to the deribit bot slot.
  // Only one Deribit bot can run at a time — switching between perp/spot
  // means stopping one and starting the other.
  const exchangeKey = (priceSource === "deribit" || priceSource === "deribit_spot") ? "deribit" : "binance";
  const bot = bots[exchangeKey];

  if (bot.running) return res.status(400).json({ error: `${EXCHANGE_TAG[exchangeKey]} bot is already running` });

  injectKeysIntoCfg(exchangeKey, cfg);

  if (!cfg.apiKey || !cfg.secretKey) {
    const which = exchangeKey === "deribit"
      ? "DERIBIT_CLIENT_ID / DERIBIT_CLIENT_SECRET"
      : "BINANCE_API_KEY / BINANCE_SECRET_KEY";
    return res.status(400).json({ error: `${which} missing in .env file` });
  }

  const required = ["priceSource","symbol","distance","avgSellSpacing","avgBuySpacing","targetSpread","qtyPerStep"];
  for (const f of required) {
    if (!cfg[f] && cfg[f] !== 0) return res.status(400).json({ error: `Missing field: ${f}` });
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

    const entryPrice = await getCurrentPrice(exchange, cfg.symbol);
    const upperLimit = parseFloat((entryPrice + cfg.distance).toFixed(8));
    const lowerLimit = parseFloat((entryPrice - cfg.distance).toFixed(8));

    Object.assign(bot, {
      config: cfg, exchange, entryPrice, lastPrice: entryPrice,
      upperLimit, lowerLimit, running: true,
      openOrders: [], fillHistory: [], pendingRoundTrips: [],
      completedRoundTrips: [], logs: [], loopCount: 0, lastNotifiedRt: 0,
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
        log("binance", `Hedge enabled: ${bot.hedge.symbol}`, "success");
      }
    }

    log(exchangeKey, `Cancelling leftover orders...`);
    try { await exchange.cancelAllOrders(cfg.symbol); }
    catch(e) {
      try {
        const prev = await exchange.fetchOpenOrders(cfg.symbol);
        for (const o of prev) { try{ await exchange.cancelOrder(o.id, cfg.symbol); }catch(_){} }
      } catch(_){}
    }

    log(exchangeKey, `Bot started! Entry: $${entryPrice} | ${cfg.symbol}`, "success");
    log(exchangeKey, `Upper: $${upperLimit}  |  Lower: $${lowerLimit}`);

    const tag = EXCHANGE_TAG[exchangeKey];
    await sendTelegram(cfg.telegramToken, cfg.telegramChatId,
      `${tag} Grid Bot Started\nSymbol: ${cfg.symbol}\nEntry: $${entryPrice}\nUpper: $${upperLimit}\nLower: $${lowerLimit}\nTime: ${new Date().toLocaleString()}`
    );

    await maintainGrid(exchangeKey, entryPrice);
    bot.loopTimer = setInterval(() => gridLoop(exchangeKey), 5000);

    res.json({ success: true, exchange: exchangeKey, entryPrice, upperLimit, lowerLimit });
  } catch (err) {
    log(exchangeKey, `Start failed: ${err.message}`, "error");
    bot.running = false;
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/stop", async (req, res) => {
  const exchangeKey = req.body?.exchange || req.query?.exchange || "binance";
  if (!bots[exchangeKey]) return res.status(400).json({ error: "Unknown exchange" });
  const bot = bots[exchangeKey];
  if (!bot.running) return res.json({ message: "Bot was not running" });

  clearInterval(bot.loopTimer);
  bot.running = false;
  log(exchangeKey, `Manual stop — cancelling orders...`, "warn");

  try {
    await cancelAllOrders(exchangeKey);
    log(exchangeKey, `All orders cancelled.`, "success");
  } catch (err) { log(exchangeKey, `Cancel error: ${err.message}`, "warn"); }

  const tag = EXCHANGE_TAG[exchangeKey];
  await sendTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID,
    `${tag} 🛑 Grid Bot Manually Stopped\n\nSymbol: ${bot.config?.symbol||"—"}\nLast Price: $${bot.lastPrice||"—"}\nTime: ${new Date().toLocaleString()}`
  );

  res.json({ success: true, exchange: exchangeKey });
  broadcast("state", buildStateSnapshot());
});

app.get("/api/portfolio", async (req, res) => {
  const exchangeKey = req.query.exchange || "binance";
  try {
    const text = exchangeKey === "deribit" ? await tgDeribitPortfolioText() : await tgBinancePortfolioText();
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
  startTelegramPoller();
});
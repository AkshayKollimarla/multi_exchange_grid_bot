// ============================================================
//  DATABASE LAYER  —  db.js
//  MySQL persistence for fills and round trips.
//  Schema columns mirror the CSV/Telegram PnL report.
//  Failures are logged but never throw — bot keeps running
//  even if MySQL is unreachable.
// ============================================================

const mysql = require("mysql2/promise");

let pool = null;
let warnedMissingConfig = false;

function dbConfigured() {
  return !!(process.env.MYSQL_HOST || process.env.MYSQL_PASSWORD);
}

function getPool() {
  if (!dbConfigured()) {
    if (!warnedMissingConfig) {
      console.log("[DB] MYSQL_* env vars not set — persistence disabled.");
      warnedMissingConfig = true;
    }
    return null;
  }
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.MYSQL_HOST     || "127.0.0.1",
      port:     parseInt(process.env.MYSQL_PORT || "3306", 10),
      user:     process.env.MYSQL_USER     || "gridbot",
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE || "gridbot",
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      timezone: "Z",
    });
  }
  return pool;
}

async function pingDb() {
  const p = getPool();
  if (!p) return false;
  try {
    const conn = await p.getConnection();
    await conn.query("SELECT 1");
    conn.release();
    console.log("[DB] Connected to MySQL.");
    return true;
  } catch (e) {
    console.error("[DB] Ping failed:", e.message);
    return false;
  }
}

function toMysqlDate(iso) {
  // mysql2 accepts Date objects directly
  return iso ? new Date(iso) : null;
}

// fill: { side, price, qty, type, ts, fee, feeCcy, orderId }
async function recordFill(bot, fill) {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute(
      `INSERT IGNORE INTO fills
       (bot_id, exchange, symbol, order_id, side, fill_type, price, qty, fee, fee_currency, filled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot.botId || bot.exchangeKey,
        bot.exchangeKey,
        bot.config?.symbol || "",
        fill.orderId ? String(fill.orderId) : null,
        fill.side,
        fill.type || null,
        fill.price,
        fill.qty,
        fill.fee || 0,
        fill.feeCcy || null,
        toMysqlDate(fill.ts),
      ]
    );
  } catch (e) {
    console.error("[DB] recordFill failed:", e.message);
  }
}

// rt: { id, openSide, buyPrice, sellPrice, qty, pnl, openTs, closeTs, durationMs }
async function recordRoundTrip(bot, rt, sequenceNumber) {
  const p = getPool();
  if (!p) return;
  try {
    const spread      = +(rt.sellPrice - rt.buyPrice).toFixed(8);
    const durationSec = +((rt.durationMs || 0) / 1000).toFixed(3);
    await p.execute(
      `INSERT INTO round_trips
       (round_trip, bot_id, exchange, symbol, open_side, buy_price, sell_price, qty, spread, pnl, duration_sec, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sequenceNumber,
        bot.botId || bot.exchangeKey,
        bot.exchangeKey,
        bot.config?.symbol || "",
        rt.openSide,
        rt.buyPrice,
        rt.sellPrice,
        rt.qty,
        spread,
        rt.pnl,
        durationSec,
        toMysqlDate(rt.openTs),
        toMysqlDate(rt.closeTs),
      ]
    );
  } catch (e) {
    console.error("[DB] recordRoundTrip failed:", e.message);
  }
}

// Period-filtered report from DB — same shape as the in-memory report.
async function queryReport({ exchange, fromTs, toTs }) {
  const p = getPool();
  if (!p) return null;
  const from = new Date(fromTs);
  const to   = new Date(toTs);

  const params = exchange ? [exchange, from, to] : [from, to];
  const exchClause = exchange ? "exchange = ? AND " : "";

  const [rtRows] = await p.execute(
    `SELECT round_trip, bot_id, exchange, symbol, open_side, buy_price, sell_price,
            qty, spread, pnl, duration_sec, opened_at, closed_at
     FROM round_trips
     WHERE ${exchClause} closed_at BETWEEN ? AND ?
     ORDER BY closed_at DESC`,
    params
  );

  const [fillRows] = await p.execute(
    `SELECT side, fee FROM fills WHERE ${exchClause} filled_at BETWEEN ? AND ?`,
    params
  );

  let totalFees = 0, totalRebates = 0;
  let periodBuys = 0, periodSells = 0;
  for (const f of fillRows) {
    const fee = Number(f.fee) || 0;
    if (fee > 0) totalFees   += fee;
    else         totalRebates += -fee;
    if (f.side === "buy")  periodBuys++;
    if (f.side === "sell") periodSells++;
  }

  const roundTrips = rtRows.map(r => ({
    openSide  : String(r.open_side).toUpperCase(),
    buyPrice  : Number(r.buy_price),
    sellPrice : Number(r.sell_price),
    qty       : Number(r.qty),
    pnl       : Number(r.pnl),
    openTs    : r.opened_at,
    closeTs   : r.closed_at,
    durationMs: Math.round(Number(r.duration_sec) * 1000),
  }));

  const count = roundTrips.length;
  const pnl   = +roundTrips.reduce((s, r) => s + r.pnl, 0).toFixed(4);
  const wins   = roundTrips.filter(r => r.pnl > 0).length;
  const losses = roundTrips.filter(r => r.pnl < 0).length;
  const winRate = count > 0 ? Math.round((wins / count) * 100) : 0;
  const avgSpread = count > 0
    ? +(roundTrips.reduce((s, r) => s + (r.sellPrice - r.buyPrice), 0) / count).toFixed(6)
    : 0;
  const perRtPnl = count > 0 ? +(pnl / count).toFixed(6) : 0;
  const netPnl = +(pnl - totalFees + totalRebates).toFixed(6);

  return {
    count, pnl, wins, losses, winRate, roundTrips,
    periodBuys, periodSells, perRtPnl, avgSpread,
    totalFees: +totalFees.toFixed(6),
    totalRebates: +totalRebates.toFixed(6),
    netPnl,
  };
}

module.exports = { getPool, pingDb, recordFill, recordRoundTrip, queryReport, dbConfigured };

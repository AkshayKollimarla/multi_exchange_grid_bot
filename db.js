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
    // Auto-create bot_sessions table on first connect so deploys don't
    // need a separate migration step.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        bot_id      VARCHAR(64) NOT NULL PRIMARY KEY,
        exchange    VARCHAR(32) NOT NULL,
        config_json JSON        NOT NULL,
        started_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB
    `);
    // Auto-add fee columns to round_trips if missing. Idempotent — ignore
    // "Duplicate column" errors on subsequent boots.
    for (const col of [
      "ADD COLUMN gross_pnl DECIMAL(20,8) NULL",
      "ADD COLUMN total_fee DECIMAL(20,8) NULL",
      "ADD COLUMN net_pnl   DECIMAL(20,8) NULL",
    ]) {
      try { await conn.query(`ALTER TABLE round_trips ${col}`); }
      catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
    }
    conn.release();
    console.log("[DB] Connected to MySQL.");
    return true;
  } catch (e) {
    console.error("[DB] Ping failed:", e.message);
    return false;
  }
}

// Save (or upsert) a running bot session so we can resume it after restart.
// Caller is responsible for stripping secrets — see stripSecrets in server.js.
async function saveSession(botId, exchange, config) {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute(
      `INSERT INTO bot_sessions (bot_id, exchange, config_json)
       VALUES (?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE exchange = VALUES(exchange), config_json = VALUES(config_json)`,
      [botId, exchange, JSON.stringify(config)]
    );
  } catch (e) {
    console.error("[DB] saveSession failed:", e.message);
  }
}

async function clearSession(botId) {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute("DELETE FROM bot_sessions WHERE bot_id = ?", [botId]);
  } catch (e) {
    console.error("[DB] clearSession failed:", e.message);
  }
}

async function loadAllSessions() {
  const p = getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query(
      "SELECT bot_id, exchange, config_json FROM bot_sessions ORDER BY started_at ASC"
    );
    return rows.map(r => ({
      botId: r.bot_id,
      exchange: r.exchange,
      // mysql2 returns JSON columns already parsed as objects
      config: typeof r.config_json === "string" ? JSON.parse(r.config_json) : r.config_json,
    }));
  } catch (e) {
    console.error("[DB] loadAllSessions failed:", e.message);
    return [];
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
    const grossPnl    = rt.grossPnl ?? rt.pnl ?? 0;
    const totalFee    = rt.totalFee ?? 0;
    const netPnl      = rt.netPnl   ?? (grossPnl - totalFee);
    await p.execute(
      `INSERT INTO round_trips
       (round_trip, bot_id, exchange, symbol, open_side, buy_price, sell_price, qty, spread, pnl, duration_sec, opened_at, closed_at, gross_pnl, total_fee, net_pnl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        grossPnl,
        totalFee,
        netPnl,
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
            qty, spread, pnl, duration_sec, opened_at, closed_at,
            gross_pnl, total_fee, net_pnl
     FROM round_trips
     WHERE ${exchClause} closed_at BETWEEN ? AND ?
     ORDER BY closed_at DESC`,
    params
  );

  const [fillRows] = await p.execute(
    `SELECT side, fee FROM fills WHERE ${exchClause} filled_at BETWEEN ? AND ?`,
    params
  );

  let periodBuys = 0, periodSells = 0;
  for (const f of fillRows) {
    if (f.side === "buy")  periodBuys++;
    if (f.side === "sell") periodSells++;
  }

  const roundTrips = rtRows.map(r => {
    const grossPnl = r.gross_pnl != null ? Number(r.gross_pnl) : Number(r.pnl);
    const totalFee = r.total_fee != null ? Number(r.total_fee) : 0;
    const netPnl   = r.net_pnl   != null ? Number(r.net_pnl)   : (grossPnl - totalFee);
    return {
      openSide  : String(r.open_side).toUpperCase(),
      buyPrice  : Number(r.buy_price),
      sellPrice : Number(r.sell_price),
      qty       : Number(r.qty),
      pnl       : Number(r.pnl),
      grossPnl, totalFee, netPnl,
      openTs    : r.opened_at,
      closeTs   : r.closed_at,
      durationMs: Math.round(Number(r.duration_sec) * 1000),
    };
  });

  const count = roundTrips.length;
  const pnl   = +roundTrips.reduce((s, r) => s + r.grossPnl, 0).toFixed(4);
  const wins   = roundTrips.filter(r => r.netPnl > 0).length;
  const losses = roundTrips.filter(r => r.netPnl < 0).length;
  const winRate = count > 0 ? Math.round((wins / count) * 100) : 0;
  const avgSpread = count > 0
    ? +(roundTrips.reduce((s, r) => s + (r.sellPrice - r.buyPrice), 0) / count).toFixed(6)
    : 0;
  const perRtPnl = count > 0 ? +(pnl / count).toFixed(6) : 0;
  // Use per-RT fees (more accurate than scanning fills, since fills may
  // include orphaned ones not tied to a closed RT).
  const totalFees = +roundTrips.reduce((s, r) => s + r.totalFee, 0).toFixed(6);
  const netPnl   = +roundTrips.reduce((s, r) => s + r.netPnl,   0).toFixed(6);

  return {
    count, pnl, wins, losses, winRate, roundTrips,
    periodBuys, periodSells, perRtPnl, avgSpread,
    totalFees,
    totalRebates: 0,
    netPnl,
  };
}

// Load the most recent round trips for a given (exchange, symbol) and
// return them in the in-memory shape used by bot.completedRoundTrips
// (newest first). Fee breakdown isn't persisted, so grossPnl/totalFee/netPnl
// fall back to pnl/0/pnl for historical rows.
async function loadRecentRoundTrips({ exchange, symbol, limit = 200 }) {
  const p = getPool();
  if (!p) return [];
  try {
    const lim = parseInt(limit, 10) || 200;
    const [rows] = await p.query(
      `SELECT round_trip, open_side, buy_price, sell_price, qty, pnl, duration_sec, opened_at, closed_at
       FROM round_trips
       WHERE exchange = ? AND symbol = ?
       ORDER BY closed_at DESC
       LIMIT ${lim}`,
      [exchange, symbol]
    );
    return rows.map(r => {
      const openSide   = String(r.open_side).toLowerCase();
      const buyPrice   = Number(r.buy_price);
      const sellPrice  = Number(r.sell_price);
      const openPrice  = openSide === "buy"  ? buyPrice  : sellPrice;
      const closePrice = openSide === "buy"  ? sellPrice : buyPrice;
      const pnl        = Number(r.pnl);
      return {
        id: `db_${r.round_trip}`,
        openSide, openPrice, closePrice, buyPrice, sellPrice,
        qty: Number(r.qty),
        pnl,
        grossPnl: pnl, totalFee: 0, netPnl: pnl,
        openTs: r.opened_at instanceof Date ? r.opened_at.toISOString() : r.opened_at,
        closeTs: r.closed_at instanceof Date ? r.closed_at.toISOString() : r.closed_at,
        durationMs: Math.round(Number(r.duration_sec) * 1000),
      };
    });
  } catch (e) {
    console.error("[DB] loadRecentRoundTrips failed:", e.message);
    return [];
  }
}

module.exports = {
  getPool, pingDb, recordFill, recordRoundTrip, queryReport,
  loadRecentRoundTrips, saveSession, clearSession, loadAllSessions,
  dbConfigured,
};

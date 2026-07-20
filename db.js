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
    // Persisted in-memory state for true continuation across restarts.
    try { await conn.query("ALTER TABLE bot_sessions ADD COLUMN state_json JSON NULL"); }
    catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
    // Options Multi-Agent Database — strategies logged via the Options DB
    // sidebar section (Dashboard / Add Strategy / Combined Simulator /
    // Analysis). Mirrors the schema of the standalone options_pnl_report app
    // (same field set), stored here so it lives in the grid bot's own MySQL.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS options_trades (
        id                          INT AUTO_INCREMENT PRIMARY KEY,
        entry_date                  DATE          NULL,
        token                       VARCHAR(50)   NOT NULL,
        option_type                 VARCHAR(10)   DEFAULT 'PUT',
        investment                  DECIMAL(20,4) DEFAULT 0,
        options_strike              VARCHAR(50)   NULL,
        expiry                      DATE          NULL,
        opt_entry_qty               DECIMAL(20,4) DEFAULT 0,
        opt_entry_price             DECIMAL(20,4) DEFAULT 0,
        opt_exit_price              DECIMAL(20,4) DEFAULT 0,
        fut_qty                     DECIMAL(20,4) DEFAULT 0,
        fut_entry_price             DECIMAL(20,4) DEFAULT 0,
        fut_exit_price              DECIMAL(20,4) DEFAULT 0,
        upside_distance             DECIMAL(20,4) DEFAULT 0,
        down_distance               DECIMAL(20,4) DEFAULT 0,
        basket_distance             DECIMAL(20,4) DEFAULT 0,
        basket_loss                 DECIMAL(20,4) DEFAULT 0,
        net_booked_pnl              DECIMAL(20,4) DEFAULT 0,
        market_making_pl            DECIMAL(20,4) DEFAULT 0,
        end_date                    DATE          NULL,
        status                      VARCHAR(10)   DEFAULT 'open',
        group_id                    VARCHAR(64)   NULL,
        days_to_expiry              INT           DEFAULT 0,
        total_theta_gain_loss       DECIMAL(20,4) DEFAULT 0,
        per_day_theta_gain_loss     DECIMAL(20,4) DEFAULT 0,
        total_baskets               DECIMAL(20,4) DEFAULT 0,
        total_mm_loss               DECIMAL(20,4) DEFAULT 0,
        upper_limit                 DECIMAL(20,4) DEFAULT 0,
        lower_limit                 DECIMAL(20,4) DEFAULT 0,
        upside_opt_pnl              DECIMAL(20,4) DEFAULT 0,
        down_opt_pnl                DECIMAL(20,4) DEFAULT 0,
        upside_fut_pnl              DECIMAL(20,4) DEFAULT 0,
        downside_fut_pnl            DECIMAL(20,4) DEFAULT 0,
        estimated_upside_net_pnl    DECIMAL(20,4) DEFAULT 0,
        estimated_downside_net_pnl  DECIMAL(20,4) DEFAULT 0,
        apy                         DECIMAL(10,4) DEFAULT 0,
        execution_json              JSON          NULL,
        created_at                  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_opt_token  (token),
        INDEX idx_opt_status (status),
        INDEX idx_opt_group  (group_id),
        INDEX idx_opt_entry_date (entry_date)
      ) ENGINE=InnoDB
    `);
    // Upgrade older installs that pre-date the Save & Execute feature.
    try { await conn.query("ALTER TABLE options_trades ADD COLUMN execution_json JSON NULL"); }
    catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
    // Which trading_accounts row this leg executes against — NULL means
    // "use the global .env Deribit key", exactly today's behavior, so every
    // existing row (and anything that never sets it) is unaffected.
    try { await conn.query("ALTER TABLE options_trades ADD COLUMN account_id INT NULL DEFAULT NULL"); }
    catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }

    // Trading accounts (multiple wallets/keys per exchange). Credentials are
    // stored as JSON so each exchange can keep its own shape:
    //   hyperliquid → { walletAddress, privateKey }
    //   binance     → { apiKey, secretKey }
    //   deribit     → { clientId, clientSecret }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS trading_accounts (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        name           VARCHAR(64)  NOT NULL,
        exchange       VARCHAR(32)  NOT NULL DEFAULT 'hyperliquid',
        wallet_address VARCHAR(128) NULL,
        private_key    VARCHAR(200) NULL,
        credentials    JSON         NULL,
        created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uq_name_exch (name, exchange)
      ) ENGINE=InnoDB
    `);
    // Upgrade older installs: add credentials + relax the HL-only columns.
    try { await conn.query("ALTER TABLE trading_accounts ADD COLUMN credentials JSON NULL"); }
    catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
    try { await conn.query("ALTER TABLE trading_accounts MODIFY wallet_address VARCHAR(128) NULL"); } catch (e) {}
    try { await conn.query("ALTER TABLE trading_accounts MODIFY private_key VARCHAR(200) NULL"); } catch (e) {}

    // Auto-close jobs (single-leg) — server-side worker polls combined
    // coin+USDC equity and closes the option (maker) + futures hedge
    // (market) once it rises by target_pnl. Ported from the standalone
    // options_pnl_report app's auto-close feature; ported schema drops
    // account_id since this deploy only ever uses the one global Deribit key.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS auto_close_jobs (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        trade_id            INT NULL,
        token               VARCHAR(50)  NOT NULL,
        opt_instrument      VARCHAR(100) NOT NULL,
        opt_qty             DECIMAL(12,6) NOT NULL,
        opt_dir             ENUM('buy','sell') NOT NULL,
        opt_entry_price     DECIMAL(18,8) NULL,
        opt_close_price     DECIMAL(18,8) NULL,
        opt_order_id        VARCHAR(100) NULL,
        opt_filled_qty      DECIMAL(12,6) NULL,
        opt_order_placed_at DATETIME NULL,
        fut_instrument      VARCHAR(100) NOT NULL DEFAULT '',
        fut_qty             DECIMAL(12,6) NOT NULL DEFAULT 0,
        fut_dir             ENUM('buy','sell') NOT NULL DEFAULT 'sell',
        fut_entry_price     DECIMAL(18,4) NULL,
        fut_close_price     DECIMAL(18,4) NULL,
        initial_total_usd   DECIMAL(14,4) NOT NULL,
        final_equity_usd    DECIMAL(14,4) NULL,
        target_pnl          DECIMAL(12,4) NOT NULL,
        target_total_usd    DECIMAL(14,4) NOT NULL,
        status              ENUM('active','closing_option','closing_futures','completed','failed','stopped')
                            NOT NULL DEFAULT 'active',
        approach_alert_sent TINYINT(1) NOT NULL DEFAULT 0,
        triggered_at        DATETIME NULL,
        completed_at        DATETIME NULL,
        last_checked_at     DATETIME NULL,
        last_equity_usd     DECIMAL(14,4) NULL,
        log_json            LONGTEXT NULL,
        error_msg           TEXT NULL,
        consecutive_errors  INT NOT NULL DEFAULT 0,
        created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ac_trade  (trade_id),
        INDEX idx_ac_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // NULL = the global .env Deribit key, matching every job created before
    // per-account execution existed (including any already-active job).
    try { await conn.query("ALTER TABLE auto_close_jobs ADD COLUMN account_id INT NULL DEFAULT NULL"); }
    catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }

    // Auto-close jobs (multi-leg / Combined Simulator) — same design as
    // auto_close_jobs, spanning N option+futures leg pairs sharing one
    // combined-equity target. group_id joins back to options_trades.group_id.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS auto_close_combo_jobs (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        group_id            VARCHAR(100) NULL,
        token               VARCHAR(50) NOT NULL,
        initial_total_usd   DECIMAL(14,4) NOT NULL,
        final_equity_usd    DECIMAL(14,4) NULL,
        target_pnl          DECIMAL(12,4) NOT NULL,
        target_total_usd    DECIMAL(14,4) NOT NULL,
        status              ENUM('active','closing','completed','failed','stopped') NOT NULL DEFAULT 'active',
        approach_alert_sent TINYINT(1) NOT NULL DEFAULT 0,
        triggered_at        DATETIME NULL,
        completed_at        DATETIME NULL,
        last_checked_at     DATETIME NULL,
        last_equity_usd     DECIMAL(14,4) NULL,
        log_json            LONGTEXT NULL,
        error_msg           TEXT NULL,
        consecutive_errors  INT NOT NULL DEFAULT 0,
        created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_acc_group  (group_id),
        INDEX idx_acc_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // One account per combo job (inherited by every leg) — a combo spanning
    // two Deribit accounts isn't a supported scenario, since the whole point
    // is one shared equity target across all its legs.
    try { await conn.query("ALTER TABLE auto_close_combo_jobs ADD COLUMN account_id INT NULL DEFAULT NULL"); }
    catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS auto_close_combo_legs (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        combo_job_id     INT NOT NULL,
        leg_index        INT NOT NULL,
        leg_type         VARCHAR(20) NULL,
        opt_instrument   VARCHAR(100) NOT NULL DEFAULT '',
        opt_qty          DECIMAL(12,6) NOT NULL DEFAULT 0,
        opt_dir          ENUM('buy','sell') NOT NULL DEFAULT 'sell',
        opt_entry_price  DECIMAL(18,8) NULL,
        opt_close_price  DECIMAL(18,8) NULL,
        opt_order_id     VARCHAR(100) NULL,
        opt_done         TINYINT(1) NOT NULL DEFAULT 0,
        fut_instrument   VARCHAR(100) NOT NULL DEFAULT '',
        fut_qty          DECIMAL(12,6) NOT NULL DEFAULT 0,
        fut_dir          ENUM('buy','sell') NOT NULL DEFAULT 'sell',
        fut_entry_price  DECIMAL(18,4) NULL,
        fut_close_price  DECIMAL(18,4) NULL,
        fut_done         TINYINT(1) NOT NULL DEFAULT 0,
        INDEX idx_accl_job (combo_job_id),
        FOREIGN KEY (combo_job_id) REFERENCES auto_close_combo_jobs(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

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

// Save the bot's in-memory state (open orders, pending RTs, etc.) so a
// restart can pick up exactly where it left off. Called from gridLoop,
// throttled by the caller (we do raw writes here).
async function saveSessionState(botId, state) {
  const p = getPool();
  if (!p) return;
  try {
    await p.execute(
      "UPDATE bot_sessions SET state_json = CAST(? AS JSON) WHERE bot_id = ?",
      [JSON.stringify(state), botId]
    );
  } catch (e) {
    console.error("[DB] saveSessionState failed:", e.message);
  }
}

async function loadAllSessions() {
  const p = getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query(
      "SELECT bot_id, exchange, config_json, state_json FROM bot_sessions ORDER BY started_at ASC"
    );
    return rows.map(r => ({
      botId: r.bot_id,
      exchange: r.exchange,
      // mysql2 returns JSON columns already parsed as objects
      config: typeof r.config_json === "string" ? JSON.parse(r.config_json) : r.config_json,
      state:  r.state_json == null ? null
            : (typeof r.state_json === "string" ? JSON.parse(r.state_json) : r.state_json),
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
async function queryReport({ exchange, fromTs, toTs, symbol }) {
  const p = getPool();
  if (!p) return null;
  const from = new Date(fromTs);
  const to   = new Date(toTs);

  const exchClause = exchange ? "exchange = ? AND " : "";

  // Coins for the PnL Report dropdown: every symbol ever traded on this
  // exchange (round trips OR fills), all-time and NOT filtered by the selected
  // coin/period — so a coin is selectable even before it has any closed round
  // trip (e.g. a freshly-started coin that has only placed entries so far).
  const symWhere = exchange ? "WHERE exchange = ?" : "";
  const [symRows] = await p.execute(
    `SELECT symbol FROM (
       SELECT DISTINCT symbol FROM round_trips ${symWhere}
       UNION
       SELECT DISTINCT symbol FROM fills ${symWhere}
     ) t
     WHERE symbol IS NOT NULL AND symbol <> ''
     ORDER BY symbol`,
    exchange ? [exchange, exchange] : []
  );
  const symbols = symRows.map(r => r.symbol);

  // Accounts/exchanges for the PnL Report's Account dropdown — same
  // all-time, unfiltered-by-period approach as symbols above, but never
  // itself filtered by exchange (that's the whole point of this list).
  const [exRows] = await p.execute(
    `SELECT exchange FROM (
       SELECT DISTINCT exchange FROM round_trips
       UNION
       SELECT DISTINCT exchange FROM fills
     ) t
     WHERE exchange IS NOT NULL AND exchange <> ''
     ORDER BY exchange`
  );
  const exchanges = exRows.map(r => r.exchange);

  // Optional per-coin filter for the actual report figures.
  const symClause = symbol ? "symbol = ? AND " : "";
  const params = [];
  if (exchange) params.push(exchange);
  if (symbol)   params.push(symbol);
  params.push(from, to);

  const [rtRows] = await p.execute(
    `SELECT round_trip, bot_id, exchange, symbol, open_side, buy_price, sell_price,
            qty, spread, pnl, duration_sec, opened_at, closed_at,
            gross_pnl, total_fee, net_pnl
     FROM round_trips
     WHERE ${exchClause}${symClause} closed_at BETWEEN ? AND ?
     ORDER BY closed_at DESC`,
    params
  );

  const [fillRows] = await p.execute(
    `SELECT side, fee FROM fills WHERE ${exchClause}${symClause} filled_at BETWEEN ? AND ?`,
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
      symbol    : r.symbol,
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
    symbols,
    exchanges,
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

// ── Trading accounts (multi-wallet) ─────────────────────────
// listAccounts() never returns the private key. getAccount(id) does, for
// internal use when starting a bot on that account.
// mysql2 may return a JSON column already parsed or as a string — handle both.
function parseCreds(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// The non-secret identifier shown in the UI, per exchange.
function accountIdentifier(exchange, c) {
  if (exchange === "binance") return c.apiKey || "";
  if (exchange === "deribit") return c.clientId || "";
  return c.walletAddress || "";   // hyperliquid
}

async function listAccounts() {
  const p = getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query(
      "SELECT id, name, exchange, wallet_address, credentials, created_at FROM trading_accounts ORDER BY name ASC"
    );
    return rows.map(r => {
      const c = parseCreds(r.credentials);
      return {
        id: r.id, name: r.name, exchange: r.exchange,
        identifier: accountIdentifier(r.exchange, c) || r.wallet_address || "",
        createdAt: r.created_at,
      };
    });
  } catch (e) {
    console.error("[DB] listAccounts failed:", e.message);
    return [];
  }
}

// Returns credentials (incl. secrets) — internal use only, e.g. starting a bot.
async function getAccount(id) {
  const p = getPool();
  if (!p) return null;
  try {
    const [rows] = await p.query(
      "SELECT id, name, exchange, wallet_address, private_key, credentials FROM trading_accounts WHERE id = ?",
      [id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    const c = parseCreds(r.credentials);
    // Back-compat: legacy HL rows kept creds in dedicated columns.
    if (!c.walletAddress && r.wallet_address) c.walletAddress = r.wallet_address;
    if (!c.privateKey && r.private_key)       c.privateKey    = r.private_key;
    return { id: r.id, name: r.name, exchange: r.exchange, credentials: c };
  } catch (e) {
    console.error("[DB] getAccount failed:", e.message);
    return null;
  }
}

async function addAccount({ name, exchange = "hyperliquid", credentials = {} }) {
  const p = getPool();
  if (!p) throw new Error("MySQL not configured");
  const [res] = await p.execute(
    "INSERT INTO trading_accounts (name, exchange, credentials) VALUES (?, ?, CAST(? AS JSON))",
    [name, exchange, JSON.stringify(credentials)]
  );
  return res.insertId;
}

async function deleteAccount(id) {
  const p = getPool();
  if (!p) return;
  try { await p.execute("DELETE FROM trading_accounts WHERE id = ?", [id]); }
  catch (e) { console.error("[DB] deleteAccount failed:", e.message); }
}

// Guards account deletion: refuses if this account is behind an open
// strategy or an active/closing job, so deleting it can never yank
// credentials out from under something still executing.
async function isAccountReferenced(id) {
  const p = getPool();
  if (!p) return false;
  const [[a]] = await p.query("SELECT COUNT(*) c FROM options_trades WHERE account_id = ? AND status = 'open'", [id]);
  if (a.c > 0) return true;
  const [[b]] = await p.query(
    "SELECT COUNT(*) c FROM auto_close_jobs WHERE account_id = ? AND status IN ('active','closing_option','closing_futures')", [id]
  );
  if (b.c > 0) return true;
  const [[c]] = await p.query(
    "SELECT COUNT(*) c FROM auto_close_combo_jobs WHERE account_id = ? AND status IN ('active','closing')", [id]
  );
  return c.c > 0;
}

// ============================================================
//  OPTIONS MULTI-AGENT DATABASE
//  Ported 1:1 from the standalone options_pnl_report app
//  (lib/options-calculations.js "computeDerived") so the PnL
//  formulas match exactly. Derived fields are recomputed
//  server-side on every insert/update — never trusted from the client.
// ============================================================
const OPT_MANUAL_COLS = [
  "entry_date","token","option_type","investment","options_strike","expiry",
  "opt_entry_qty","opt_entry_price","opt_exit_price",
  "fut_qty","fut_entry_price","fut_exit_price",
  "upside_distance","down_distance","basket_distance","basket_loss",
  "net_booked_pnl","market_making_pl","end_date","status","group_id","account_id",
];
const OPT_DERIVED_COLS = [
  "days_to_expiry","total_theta_gain_loss","per_day_theta_gain_loss",
  "total_baskets","total_mm_loss","upper_limit","lower_limit",
  "upside_opt_pnl","down_opt_pnl","upside_fut_pnl","downside_fut_pnl",
  "estimated_upside_net_pnl","estimated_downside_net_pnl","apy",
];
const OPT_ALL_COLS = [...OPT_MANUAL_COLS, ...OPT_DERIVED_COLS];

function optStrikeNumber(strike) {
  if (!strike) return 0.0;
  const m = String(strike).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0.0;
}
function optF(v) { const n = parseFloat(v); return isNaN(n) ? 0.0 : n; }
function optDiv(a, b) { return b === 0 ? 0.0 : a / b; }

function computeOptionsDerived(d) {
  const entryDate = d.entry_date ? new Date(d.entry_date) : new Date();
  const expiry    = d.expiry     ? new Date(d.expiry)     : null;

  let days_to_expiry = 0;
  if (expiry && !isNaN(entryDate) && !isNaN(expiry)) {
    days_to_expiry = Math.round((expiry - entryDate) / 86400000);
  }

  const opt_entry_qty    = optF(d.opt_entry_qty);
  const opt_entry_price  = optF(d.opt_entry_price);
  const fut_qty           = optF(d.fut_qty);
  const fut_entry_price   = optF(d.fut_entry_price);
  const upside_distance   = optF(d.upside_distance);
  const down_distance     = optF(d.down_distance);
  const basket_distance   = optF(d.basket_distance);
  const basket_loss       = optF(d.basket_loss);
  const market_making_pl  = optF(d.market_making_pl);
  const investment        = optF(d.investment);
  const option_type       = (d.option_type || "PUT").toUpperCase();
  const strike_num        = optStrikeNumber(d.options_strike);

  // opt_entry_qty is negative for SHORT legs, positive for LONG — theta decay
  // is a gain for a short seller and a loss for a long holder, i.e. the
  // opposite sign of the raw qty*price product.
  const total_theta_gain_loss   = -(opt_entry_qty * opt_entry_price);
  const per_day_theta_gain_loss = optDiv(total_theta_gain_loss, days_to_expiry);
  const total_baskets           = optDiv(down_distance, basket_distance);

  const blbd          = optDiv(basket_loss, basket_distance);
  const mm            = (basket_loss * total_baskets) + (blbd + blbd / 2 + blbd / 2) * (down_distance / 2);
  const total_mm_loss = -mm;

  const upper_limit = fut_entry_price + upside_distance;
  const lower_limit = fut_entry_price - down_distance;

  let upside_opt_pnl, down_opt_pnl;
  if (option_type === "CALL") {
    const breakeven = strike_num + opt_entry_price;
    upside_opt_pnl = breakeven > upper_limit
      ? -(opt_entry_price * opt_entry_qty)
      : (upper_limit - breakeven) * opt_entry_qty;
    down_opt_pnl = opt_entry_price * (-opt_entry_qty);
  } else { // PUT
    const net_strike = strike_num - opt_entry_price;
    down_opt_pnl = net_strike < lower_limit
      ? -(opt_entry_price * opt_entry_qty)
      : (net_strike - lower_limit) * opt_entry_qty;
    upside_opt_pnl = opt_entry_price * (-opt_entry_qty);
  }

  const upside_fut_pnl             = fut_qty * upside_distance;
  const downside_fut_pnl           = -(fut_qty * down_distance);
  const estimated_upside_net_pnl   = total_mm_loss + upside_opt_pnl + upside_fut_pnl;
  const estimated_downside_net_pnl = total_mm_loss + down_opt_pnl + downside_fut_pnl;
  const apy                        = investment ? (market_making_pl / investment) * 365 * 100 : 0;

  return {
    days_to_expiry, total_theta_gain_loss, per_day_theta_gain_loss,
    total_baskets, total_mm_loss, upper_limit, lower_limit,
    upside_opt_pnl, down_opt_pnl, upside_fut_pnl, downside_fut_pnl,
    estimated_upside_net_pnl, estimated_downside_net_pnl, apy,
  };
}

// Empty strings -> NULL for DATE/numeric columns (MySQL strict mode).
function optSanitize(v) { return (v === "" || v === undefined) ? null : v; }

async function listOptionsTrades({ status, token, groupId, dateFrom, dateTo, page = 1, limit = 50 } = {}) {
  const p = getPool();
  if (!p) return null;
  const conditions = [], params = [];
  if (groupId) {
    conditions.push("group_id = ?"); params.push(groupId);
  } else {
    if (status && status !== "all") { conditions.push("status = ?"); params.push(status); }
    if (token)   { conditions.push("token LIKE ?");      params.push(`%${token}%`); }
    if (dateFrom){ conditions.push("entry_date >= ?");   params.push(dateFrom); }
    if (dateTo)  { conditions.push("entry_date <= ?");   params.push(dateTo); }
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = `ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, entry_date DESC, id DESC`;

  if (groupId) {
    const [rows] = await p.query(`SELECT * FROM options_trades ${where} ${order}`, params);
    return { trades: rows };
  }

  const lim    = Math.min(9999, Math.max(10, parseInt(limit, 10) || 50));
  const pg     = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pg - 1) * lim;
  const [[countRows], [rows]] = await Promise.all([
    p.query(`SELECT COUNT(*) AS total FROM options_trades ${where}`, params),
    p.query(`SELECT * FROM options_trades ${where} ${order} LIMIT ? OFFSET ?`, [...params, lim, offset]),
  ]);
  const total = countRows[0].total;
  return { trades: rows, total, page: pg, pages: Math.ceil(total / lim), limit: lim };
}

async function getOptionsTrade(id) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query("SELECT * FROM options_trades WHERE id = ? LIMIT 1", [id]);
  return rows[0] || null;
}

async function addOptionsTrade(body) {
  const p = getPool();
  if (!p) throw new Error("MySQL not configured");
  if (!body.token) throw new Error("Token is required.");
  const derived = computeOptionsDerived(body);
  const row  = { ...body, ...derived };
  const cols = OPT_ALL_COLS.filter((c) => row[c] !== undefined && row[c] !== "");
  const vals = cols.map((c) => optSanitize(row[c]));
  const placeholders = cols.map(() => "?").join(", ");
  const [result] = await p.query(
    `INSERT INTO options_trades (${cols.join(", ")}) VALUES (${placeholders})`, vals
  );
  return result.insertId;
}

async function updateOptionsTrade(id, body) {
  const p = getPool();
  if (!p) throw new Error("MySQL not configured");
  const existing = await getOptionsTrade(id);
  if (!existing) throw new Error("Not found.");
  const merged  = { ...existing, ...body };
  const derived = computeOptionsDerived(merged);
  const final   = { ...merged, ...derived };
  const sets = OPT_ALL_COLS.map((c) => `${c} = ?`).join(", ");
  const vals = [...OPT_ALL_COLS.map((c) => optSanitize(final[c])), id];
  await p.query(`UPDATE options_trades SET ${sets} WHERE id = ?`, vals);
}

async function deleteOptionsTrade(id) {
  const p = getPool();
  if (!p) throw new Error("MySQL not configured");
  const [result] = await p.query("DELETE FROM options_trades WHERE id = ?", [id]);
  if (result.affectedRows === 0) throw new Error("Not found.");
}

// Audit trail for "Save & Execute" — records the order-placement result
// (instrument, side, order id, or error) for both legs, never blocking the
// caller if the write itself fails (the orders are already live either way).
async function recordOptionsExecution(id, execution) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query("UPDATE options_trades SET execution_json = CAST(? AS JSON) WHERE id = ?", [JSON.stringify(execution), id]);
  } catch (e) { console.error("[DB] recordOptionsExecution failed:", e.message); }
}

// ============================================================
//  AUTO-CLOSE JOBS (single-leg + multi-leg combo)
//  Ported from the standalone options_pnl_report app's auto-close
//  worker/routes — see lib/deribit-close-helpers.js equivalents in
//  server.js for the Deribit-side math these jobs drive.
// ============================================================

async function listAutoCloseJobs({ tradeId } = {}) {
  const p = getPool();
  if (!p) return [];
  const where = tradeId ? "WHERE trade_id = ?" : "";
  const [rows] = await p.query(
    `SELECT id, trade_id, token, opt_instrument, fut_instrument,
            opt_entry_price, opt_close_price, fut_entry_price, fut_close_price,
            initial_total_usd, final_equity_usd, target_pnl, target_total_usd, status,
            last_equity_usd, last_checked_at, created_at, triggered_at, completed_at, error_msg
       FROM auto_close_jobs ${where} ORDER BY created_at DESC`,
    tradeId ? [tradeId] : []
  );
  return rows;
}

async function getAutoCloseJob(id) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query("SELECT * FROM auto_close_jobs WHERE id = ?", [id]);
  const job = rows[0] || null;
  if (job) { try { job.logs = JSON.parse(job.log_json || "[]"); } catch (e) { job.logs = []; } delete job.log_json; }
  return job;
}

// Raw row (log_json intact) — for internal worker use, not API responses.
async function getAutoCloseJobRaw(id) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query("SELECT * FROM auto_close_jobs WHERE id = ?", [id]);
  return rows[0] || null;
}

async function findActiveAutoCloseJob(tradeId) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query(
    `SELECT id, status FROM auto_close_jobs
      WHERE trade_id = ? AND status IN ('active','closing_option','closing_futures') LIMIT 1`,
    [tradeId]
  );
  return rows[0] || null;
}

async function listActiveAutoCloseJobs() {
  const p = getPool();
  if (!p) return [];
  const [rows] = await p.query(`SELECT * FROM auto_close_jobs WHERE status IN ('active','closing_option','closing_futures')`);
  return rows;
}

async function insertAutoCloseJob(f) {
  const p = getPool();
  if (!p) throw new Error("MySQL not configured");
  const [result] = await p.query(
    `INSERT INTO auto_close_jobs
       (trade_id, token, opt_instrument, opt_qty, opt_dir, opt_entry_price,
        fut_instrument, fut_qty, fut_dir, fut_entry_price,
        initial_total_usd, target_pnl, target_total_usd, account_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      f.trade_id || null, f.token, f.opt_instrument, f.opt_qty, f.opt_dir, f.opt_entry_price ?? null,
      f.fut_instrument || "", f.fut_qty || 0, f.fut_dir || "sell", f.fut_entry_price ?? null,
      f.initial_total_usd, f.target_pnl, f.target_total_usd, f.account_id || null,
    ]
  );
  return result.insertId;
}

// fields may include the special flags `triggered`/`completed`/`opt_placed`
// (set the matching *_at column to NOW()) alongside plain column=value pairs.
async function updateAutoCloseJob(id, fields = {}) {
  const p = getPool();
  if (!p) return;
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "triggered")  { sets.push("triggered_at = NOW()"); continue; }
    if (k === "completed")  { sets.push("completed_at = NOW()"); continue; }
    if (k === "opt_placed") { sets.push("opt_order_placed_at = NOW()"); continue; }
    sets.push(`${k} = ?`); vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await p.query(`UPDATE auto_close_jobs SET ${sets.join(", ")} WHERE id = ?`, vals);
}

async function appendAutoCloseLog(id, msg) {
  const p = getPool();
  if (!p) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(`[auto-close #${id}]`, msg);
  try {
    await p.query(
      `UPDATE auto_close_jobs SET log_json = JSON_ARRAY_APPEND(COALESCE(log_json,'[]'), '$', ?) WHERE id = ?`,
      [line, id]
    );
  } catch (e) {
    const [[row]] = await p.query(`SELECT log_json FROM auto_close_jobs WHERE id=?`, [id]);
    let arr = []; try { arr = JSON.parse(row?.log_json || "[]"); } catch (e2) {}
    arr.push(line);
    await p.query(`UPDATE auto_close_jobs SET log_json=? WHERE id=?`, [JSON.stringify(arr), id]);
  }
}

// ── Combo (multi-leg) auto-close jobs ───────────────────────

async function listComboJobs({ groupId } = {}) {
  const p = getPool();
  if (!p) return [];
  const where = groupId ? "WHERE group_id = ?" : "";
  const [rows] = await p.query(
    `SELECT id, group_id, token, initial_total_usd, final_equity_usd,
            target_pnl, target_total_usd, status, last_equity_usd, last_checked_at,
            created_at, triggered_at, completed_at, error_msg
       FROM auto_close_combo_jobs ${where} ORDER BY created_at DESC`,
    groupId ? [groupId] : []
  );
  return rows;
}

async function getComboJob(id) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query("SELECT * FROM auto_close_combo_jobs WHERE id = ?", [id]);
  const job = rows[0] || null;
  if (job) { try { job.logs = JSON.parse(job.log_json || "[]"); } catch (e) { job.logs = []; } delete job.log_json; }
  return job;
}

async function getComboJobRaw(id) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query("SELECT * FROM auto_close_combo_jobs WHERE id = ?", [id]);
  return rows[0] || null;
}

async function getComboJobLegs(comboJobId) {
  const p = getPool();
  if (!p) return [];
  const [rows] = await p.query(
    `SELECT * FROM auto_close_combo_legs WHERE combo_job_id = ? ORDER BY leg_index`, [comboJobId]
  );
  return rows;
}

async function findActiveComboJob(groupId) {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query(
    `SELECT id, status FROM auto_close_combo_jobs WHERE group_id = ? AND status IN ('active','closing') LIMIT 1`,
    [groupId]
  );
  return rows[0] || null;
}

async function listActiveComboJobs() {
  const p = getPool();
  if (!p) return [];
  const [rows] = await p.query(`SELECT * FROM auto_close_combo_jobs WHERE status IN ('active','closing')`);
  return rows;
}

async function insertComboJob(f, legs) {
  const p = getPool();
  if (!p) throw new Error("MySQL not configured");
  const [result] = await p.query(
    `INSERT INTO auto_close_combo_jobs (group_id, token, initial_total_usd, target_pnl, target_total_usd, account_id)
     VALUES (?,?,?,?,?,?)`,
    [f.group_id || null, f.token, f.initial_total_usd, f.target_pnl, f.target_total_usd, f.account_id || null]
  );
  const jobId = result.insertId;
  const legRows = legs.map((leg, i) => [
    jobId, i, leg.leg_type || null,
    leg.opt_instrument || "", leg.opt_qty || 0, leg.opt_dir || "sell", leg.opt_entry_price ?? null,
    leg.fut_instrument || "", leg.fut_qty || 0, leg.fut_dir || "sell", leg.fut_entry_price ?? null,
  ]);
  await p.query(
    `INSERT INTO auto_close_combo_legs
       (combo_job_id, leg_index, leg_type, opt_instrument, opt_qty, opt_dir, opt_entry_price,
        fut_instrument, fut_qty, fut_dir, fut_entry_price)
     VALUES ?`,
    [legRows]
  );
  return jobId;
}

async function updateComboJob(id, fields = {}) {
  const p = getPool();
  if (!p) return;
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "triggered") { sets.push("triggered_at = NOW()"); continue; }
    if (k === "completed") { sets.push("completed_at = NOW()"); continue; }
    sets.push(`${k} = ?`); vals.push(v);
  }
  if (!sets.length) return;
  vals.push(id);
  await p.query(`UPDATE auto_close_combo_jobs SET ${sets.join(", ")} WHERE id = ?`, vals);
}

async function appendComboLog(id, msg) {
  const p = getPool();
  if (!p) return;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(`[auto-close-combo #${id}]`, msg);
  try {
    await p.query(
      `UPDATE auto_close_combo_jobs SET log_json = JSON_ARRAY_APPEND(COALESCE(log_json,'[]'), '$', ?) WHERE id = ?`,
      [line, id]
    );
  } catch (e) {
    const [[row]] = await p.query(`SELECT log_json FROM auto_close_combo_jobs WHERE id=?`, [id]);
    let arr = []; try { arr = JSON.parse(row?.log_json || "[]"); } catch (e2) {}
    arr.push(line);
    await p.query(`UPDATE auto_close_combo_jobs SET log_json=? WHERE id=?`, [JSON.stringify(arr), id]);
  }
}

async function updateComboLeg(legId, fields = {}) {
  const p = getPool();
  if (!p) return;
  const sets = Object.keys(fields).map((k) => `${k} = ?`);
  if (!sets.length) return;
  const vals = [...Object.values(fields), legId];
  await p.query(`UPDATE auto_close_combo_legs SET ${sets.join(", ")} WHERE id = ?`, vals);
}

module.exports = {
  getPool, pingDb, recordFill, recordRoundTrip, queryReport,
  loadRecentRoundTrips, saveSession, saveSessionState, clearSession,
  loadAllSessions, dbConfigured,
  listAccounts, getAccount, addAccount, deleteAccount, isAccountReferenced,
  listOptionsTrades, getOptionsTrade, addOptionsTrade, updateOptionsTrade,
  deleteOptionsTrade, computeOptionsDerived, optStrikeNumber, recordOptionsExecution,
  listAutoCloseJobs, getAutoCloseJob, getAutoCloseJobRaw, findActiveAutoCloseJob,
  listActiveAutoCloseJobs, insertAutoCloseJob, updateAutoCloseJob, appendAutoCloseLog,
  listComboJobs, getComboJob, getComboJobRaw, getComboJobLegs, findActiveComboJob,
  listActiveComboJobs, insertComboJob, updateComboJob, appendComboLog, updateComboLeg,
};

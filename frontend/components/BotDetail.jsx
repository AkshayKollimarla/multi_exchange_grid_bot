"use client";

import { fmtCcy } from "@/lib/format";

// Time only for today's trades ("2:45:31 PM"), date + time for older ones —
// a bare time on a multi-day run would be ambiguous.
function fmtWhen(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString()
    : d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) + " " + d.toLocaleTimeString();
}

export default function BotDetail({ bot }) {
  const stats = bot.stats || {};
  const orders = bot.openOrders || [];
  const rts = bot.completedRoundTrips || [];
  // Every individual filled order (entry and target legs alike), newest
  // first — unlike Recent Round Trips, which only lists a buy+sell pair
  // once BOTH legs have filled.
  const fills = bot.fillHistory || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
        <span className="pill pill-blue" style={{ textTransform: "none" }}>👤 Account: {bot.accountName || "Default (.env)"}</span>
        {bot.symbol && <span>Symbol: <b style={{ color: "var(--ink)" }}>{bot.symbol}</b></span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        <Stat label="Live Price" value={bot.lastPrice != null ? `$${Number(bot.lastPrice).toFixed(2)}` : "—"} cls="green" />
        <Stat label="Entry Price" value={bot.entryPrice != null ? `$${Number(bot.entryPrice).toFixed(2)}` : "—"} />
        <Stat label="Upper Limit" value={bot.upperLimit != null ? `$${bot.upperLimit}` : "—"} cls="red" />
        <Stat label="Lower Limit" value={bot.lowerLimit != null ? `$${bot.lowerLimit}` : "—"} cls="blue" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        <Stat label="Runtime" value={bot.runtimeStr || "—"} cls="blue" />
        <Stat label="Net PnL (after fees)" value={fmtCcy(stats.netPnl)} sub={`Gross: ${fmtCcy(stats.grossPnl)}`} cls="green" />
        <Stat label="Total Fees Paid" value={fmtCcy(stats.totalFees)} cls="red" sub={stats.totalRoundTrips ? `Avg: ${fmtCcy(stats.rtFees / stats.totalRoundTrips)}/RT` : undefined} />
        <Stat label="Round Trips" value={stats.totalRoundTrips ?? 0} cls="blue" sub={`Pending: ${stats.pendingLegs ?? 0}`} />
      </div>

      <div className="card">
        <div className="card-header">📋 Open Orders <span className="pill pill-blue" style={{ marginLeft: 8 }}>{orders.length}</span></div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="ord-table">
            <thead><tr><th>Type</th><th>Side</th><th>Price</th><th>Qty</th></tr></thead>
            <tbody>
              {orders.length === 0
                ? <tr><td colSpan={4} className="empty-td">No open orders</td></tr>
                : orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.type}</td>
                    <td style={{ color: o.side === "buy" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{o.side.toUpperCase()}</td>
                    <td>${o.price}</td>
                    <td>{o.qty}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-header-row">
            <span>✅ Recent Round Trips</span>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>
              Total PnL: <span style={{ color: "var(--green)" }}>{fmtCcy(rts.reduce((s, r) => s + (r.netPnl ?? 0), 0))}</span>
            </span>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="ord-table">
            <thead><tr><th>Closed</th><th>Opened</th><th>Side</th><th>Buy</th><th>Sell</th><th>Qty</th><th>Fee</th><th>Net PnL</th></tr></thead>
            <tbody>
              {rts.length === 0
                ? <tr><td colSpan={8} className="empty-td">No round trips yet — waiting for first target fill</td></tr>
                : rts.slice(0, 20).map((r, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.closeTs)}</td>
                    <td style={{ whiteSpace: "nowrap", color: "var(--muted)" }}>{fmtWhen(r.openTs)}</td>
                    <td style={{ color: r.openSide === "buy" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{String(r.openSide).toUpperCase()}</td>
                    <td>${r.buyPrice}</td>
                    <td>${r.sellPrice}</td>
                    <td>{r.qty}</td>
                    <td>{fmtCcy(r.totalFee)}</td>
                    <td style={{ color: r.netPnl >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{fmtCcy(r.netPnl)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-header-row">
            <span>🧾 Trade History</span>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 700, color: "var(--muted)" }}>
              {fills.length ? `Last fill: ${String(fills[0].side).toUpperCase()} @ $${fills[0].price}` : "No fills yet"}
            </span>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="ord-table">
            {/* No Fee column: the per-fill fee is often 0/unknown at fill time
                (the real fee is only looked up when a round trip closes), so
                it would disagree with the Fee shown in Recent Round Trips. */}
            <thead><tr><th>Time</th><th>Side</th><th>Type</th><th>Price</th><th>Qty</th></tr></thead>
            <tbody>
              {fills.length === 0
                ? <tr><td colSpan={5} className="empty-td">No fills yet — every filled order (entry or target) shows up here, newest first</td></tr>
                : fills.map((f, i) => (
                  <tr key={f.orderId ?? i}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtWhen(f.ts)}</td>
                    <td style={{ color: f.side === "buy" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{String(f.side).toUpperCase()}</td>
                    <td>{f.type}</td>
                    <td>${f.price}</td>
                    <td>{f.qty}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, cls }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${cls ? " " + cls : ""}`}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

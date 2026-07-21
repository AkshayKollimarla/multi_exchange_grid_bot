"use client";

import { fmtCcy } from "@/lib/format";

export default function BotDetail({ bot }) {
  const stats = bot.stats || {};
  const orders = bot.openOrders || [];
  const rts = bot.completedRoundTrips || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
        <span className="pill pill-blue" style={{ textTransform: "none" }}>👤 Account: {bot.accountName || "Default (.env)"}</span>
        {bot.symbol && <span>Symbol: <b style={{ color: "var(--ink)" }}>{bot.symbol}</b></span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
        <Stat label="Live Price" value={bot.lastPrice != null ? `$${bot.lastPrice}` : "—"} cls="green" />
        <Stat label="Entry Price" value={bot.entryPrice != null ? `$${bot.entryPrice}` : "—"} />
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
            <thead><tr><th>Side</th><th>Buy</th><th>Sell</th><th>Qty</th><th>Fee</th><th>Net PnL</th></tr></thead>
            <tbody>
              {rts.length === 0
                ? <tr><td colSpan={6} className="empty-td">No round trips yet — waiting for first target fill</td></tr>
                : rts.slice(0, 20).map((r, i) => (
                  <tr key={i}>
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

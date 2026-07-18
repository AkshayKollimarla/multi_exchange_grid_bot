"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiDelete } from "@/lib/api";
import { fmtCcy, fmtDate } from "@/lib/format";

const PAGE_SIZE = 50;

export default function OptionsDashboardPage() {
  const [status, setStatus] = useState("all");
  const [token, setToken] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);

  const [trades, setTrades] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Bumped by clearFilters() so a reload always fires even when the filters
  // were already at their default values — a plain state reset wouldn't
  // change status/from/to and so wouldn't re-trigger the effect below,
  // unlike the original odbClearFilters(), which always force-reloaded.
  const [reloadNonce, setReloadNonce] = useState(0);

  const debounceRef = useRef(null);

  const reload = useCallback(async (targetPage) => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (status !== "all") qs.set("status", status);
    if (token.trim()) qs.set("token", token.trim());
    if (from) qs.set("date_from", from);
    if (to) qs.set("date_to", to);
    qs.set("page", String(targetPage));
    qs.set("limit", String(PAGE_SIZE));
    try {
      const j = await apiGet(`/api/options-db/trades?${qs}`);
      setTrades(j.trades || []);
      setTotal(j.total ?? 0);
      setPages(j.pages ?? 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [status, token, from, to]);

  // Re-fetch page 1 whenever a filter changes (status/from/to trigger
  // immediately; token search is debounced, matching odbDebounceReload).
  useEffect(() => {
    setPage(1);
    reload(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, from, to, reloadNonce]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      reload(1);
    }, 400);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function gotoPage(p) {
    setPage(p);
    reload(p);
  }

  function clearFilters() {
    setStatus("all");
    setToken("");
    setFrom("");
    setTo("");
    setReloadNonce((n) => n + 1);
  }

  async function deleteTrade(id) {
    if (!confirm("Delete this strategy?")) return;
    try {
      await apiDelete(`/api/options-db/trades/${id}`);
      reload(page);
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  }

  const open = trades.filter((t) => t.status === "open").length;
  const closed = trades.filter((t) => t.status === "closed").length;
  const booked = trades
    .filter((t) => t.status === "closed")
    .reduce((s, t) => s + Number(t.net_booked_pnl || 0), 0);

  // Group combined-strategy legs under one banner row, same as odbRenderTable.
  const rows = [];
  const seenGroups = new Set();
  for (const t of trades) {
    if (t.group_id) {
      if (seenGroups.has(t.group_id)) continue;
      seenGroups.add(t.group_id);
      const members = trades.filter((x) => x.group_id === t.group_id);
      const combinedPnl = members.reduce((s, m) => s + Number(m.net_booked_pnl || 0), 0);
      rows.push({ kind: "group-banner", groupId: t.group_id, count: members.length, combinedPnl });
      for (const m of members) rows.push({ kind: "row", trade: m, combined: true, groupId: t.group_id });
    } else {
      rows.push({ kind: "row", trade: t, combined: false });
    }
  }

  return (
    <>
      <div className="header">
        <div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div>
      </div>

      <section className="section">
        <div className="sec-head">📋 Options Dashboard</div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 14 }}>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Total (page)</div><div className="stat-value blue">{trades.length} / {total}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Open (page)</div><div className="stat-value">{open}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Closed (page)</div><div className="stat-value">{closed}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Booked PnL (page)</div><div className="stat-value">{fmtCcy(booked)}</div></div>
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
            <div className="field" style={{ margin: 0, minWidth: 150 }}>
              <label>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div className="field" style={{ margin: 0, minWidth: 150 }}>
              <label>Search Token</label>
              <input type="text" placeholder="e.g. BTC" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button className="btn-refresh" onClick={clearFilters}>Clear filters</button>
            <a
              href="/index.html"
              className="btn btn-start"
              style={{ marginLeft: "auto", padding: "10px 18px", textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              title="Add Strategy isn't migrated yet — opens the classic dashboard"
            >
              ➕ Add Strategy
            </a>
          </div>
        </div>

        <div className="card">
          <div className="card-body" style={{ padding: 0 }}>
            <table className="ord-table">
              <thead>
                <tr>
                  <th>#</th><th>Date</th><th>Token</th><th>Type</th><th>Strike</th><th>Expiry</th>
                  <th>Days</th><th>Status</th><th>Investment</th><th>MM PL</th><th>Booked PnL</th><th>APY</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={13} className="empty-td">Loading…</td></tr>}
                {!loading && error && <tr><td colSpan={13} className="empty-td">Error: {error}</td></tr>}
                {!loading && !error && rows.length === 0 && (
                  <tr><td colSpan={13} className="empty-td">
                    No strategies found. <a href="/index.html">Add one.</a>
                  </td></tr>
                )}
                {!loading && !error && rows.map((r, i) =>
                  r.kind === "group-banner" ? (
                    <tr key={`g-${r.groupId}`} style={{ background: "#f5f3ff" }}>
                      <td colSpan={13} style={{ padding: "8px 12px", borderLeft: "4px solid #7c3aed" }}>
                        <span style={{ background: "#7c3aed", color: "#fff", padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                          COMBINED · {r.count} legs
                        </span>
                        <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 700, color: r.combinedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                          Combined PnL: {fmtCcy(r.combinedPnl)}
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <TradeRow key={r.trade.id} t={r.trade} combined={r.combined} groupId={r.groupId} onDelete={deleteTrade} />
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>

        {pages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 2px", fontSize: 12, color: "var(--muted)" }}>
            <span>Page {page} of {pages} · {total} records</span>
            <span>
              <button className="btn-refresh" disabled={page <= 1} onClick={() => gotoPage(page - 1)}>‹ Prev</button>{" "}
              <button className="btn-refresh" disabled={page >= pages} onClick={() => gotoPage(page + 1)}>Next ›</button>
            </span>
          </div>
        )}
      </section>
    </>
  );
}

function TradeRow({ t, combined, groupId, onDelete }) {
  const typeColor = t.option_type === "PUT" ? "var(--red)" : "var(--green)";
  const statusStyle = t.status === "open"
    ? { background: "#d1fae5", color: "#059669" }
    : { background: "#f1f5f9", color: "#475569" };
  const pnlColor = Number(t.net_booked_pnl) >= 0 ? "var(--green)" : "var(--red)";
  return (
    <tr style={combined ? { borderLeft: "4px solid #ddd6fe" } : undefined}>
      <td style={{ fontFamily: "monospace", color: "var(--muted)", fontSize: 11 }}>{t.id}</td>
      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(t.entry_date)}</td>
      <td>
        <b>{t.token}</b>
        {combined && <div style={{ fontSize: 10, color: "#a78bfa" }}>leg</div>}
      </td>
      <td><span style={{ color: typeColor, fontWeight: 700, fontSize: 11 }}>{t.option_type}</span></td>
      <td>{t.options_strike || "—"}</td>
      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(t.expiry)}</td>
      <td>{t.days_to_expiry ?? "—"}</td>
      <td><span style={{ ...statusStyle, padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 700, textTransform: "capitalize" }}>{t.status}</span></td>
      <td>{fmtCcy(t.investment)}</td>
      <td style={{ color: Number(t.market_making_pl) >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{fmtCcy(t.market_making_pl)}</td>
      <td style={{ color: pnlColor, fontWeight: 600 }}>{t.net_booked_pnl != null ? fmtCcy(t.net_booked_pnl) : "—"}</td>
      <td style={{ color: "#7c3aed", fontWeight: 600 }}>{t.apy != null ? Number(t.apy).toFixed(2) + "%" : "—"}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        {combined
          ? <a href={`/combined-simulator?group=${encodeURIComponent(groupId)}`} style={{ color: "#7c3aed", fontWeight: 600 }}>Edit Combined</a>
          : <a href="/index.html" style={{ color: "var(--brand)", fontWeight: 600 }} title="Editing isn't migrated yet — opens the classic dashboard">Edit / Close</a>}
        {" "}&nbsp;{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); onDelete(t.id); }} style={{ color: "var(--red)" }}>Delete</a>
      </td>
    </tr>
  );
}

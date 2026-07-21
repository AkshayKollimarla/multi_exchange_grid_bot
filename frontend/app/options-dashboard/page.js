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
  const [acctMap, setAcctMap] = useState({});
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

  useEffect(() => {
    apiGet("/api/accounts").then((list) => {
      const map = {};
      (Array.isArray(list) ? list : []).forEach((a) => { map[a.id] = a.name; });
      setAcctMap(map);
    }).catch(() => {});
  }, []);

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
      const perLegInv = Number(members[0]?.investment || 0);
      rows.push({ kind: "group-banner", groupId: t.group_id, count: members.length, combinedPnl, perLegInv });
      for (const m of members) rows.push({ kind: "row", trade: m, combined: true, groupId: t.group_id });
    } else {
      rows.push({ kind: "row", trade: t, combined: false });
    }
  }

  return (
    <>
      <section className="section">
        <div className="sec-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Options Strategy</span>
          <a href="/add-strategy" className="btn" style={{ textDecoration: "none", background: "var(--brand)", color: "#fff" }}>
            + Add Strategy
          </a>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 }}>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Total (this page)</div><div className="stat-value blue">{trades.length} / {total}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Open (page)</div><div className="stat-value green">{open}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Closed (page)</div><div className="stat-value">{closed}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Booked PnL (page)</div><div className="stat-value" style={{ color: booked >= 0 ? "#16a34a" : "#dc2626" }}>{fmtCcy(booked)}</div></div>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <div className="tab-row" style={{ margin: 0 }}>
              <button className={`tab-btn${status === "all" ? " active" : ""}`} onClick={() => setStatus("all")}>All</button>
              <button className={`tab-btn${status === "open" ? " active" : ""}`} onClick={() => setStatus("open")}>Open</button>
              <button className={`tab-btn${status === "closed" ? " active" : ""}`} onClick={() => setStatus("closed")}>Closed</button>
            </div>
            <div className="search-box" style={{ minWidth: 180 }}>
              <span className="search-icon">🔍</span>
              <input type="text" placeholder="Search token…" value={token} onChange={(e) => setToken(e.target.value)}
                style={{ height: 38, padding: "0 12px 0 34px", border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", fontSize: 13, width: "100%" }} />
            </div>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              style={{ height: 38, padding: "0 12px", border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", fontSize: 13 }} />
            <span style={{ color: "var(--muted-2)", fontSize: 12 }}>to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              style={{ height: 38, padding: "0 12px", border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", fontSize: 13 }} />
            <button className="btn-refresh" onClick={clearFilters} style={{ height: 38 }}>Clear filters</button>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted-2)" }}>{total} records total</span>
          </div>
        </div>

        <div className="card">
          <div className="card-body" style={{ padding: 0 }}>
            <table className="ord-table">
              <thead>
                <tr>
                  <th>#</th><th>Date</th><th>Token</th><th>Account</th><th>Type</th><th>Strike</th><th>Expiry</th>
                  <th>Days</th><th>Status</th><th>Investment</th><th>MM PL</th><th>Booked PnL</th><th>APY</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={14} className="empty-td">Loading…</td></tr>}
                {!loading && error && <tr><td colSpan={14} className="empty-td">Error: {error}</td></tr>}
                {!loading && !error && rows.length === 0 && (
                  <tr><td colSpan={14} className="empty-td">
                    No strategies found. <a href="/add-strategy">Add one.</a>
                  </td></tr>
                )}
                {!loading && !error && rows.map((r, i) =>
                  r.kind === "group-banner" ? (
                    <tr key={`g-${r.groupId}`} style={{ background: "var(--purple-soft)" }}>
                      <td colSpan={14} style={{ padding: "10px 16px", borderLeft: "4px solid var(--purple)" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "var(--purple)", color: "#fff", padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700, letterSpacing: ".02em" }}>
                          🔗 COMBINED STRATEGY
                        </span>
                        <span style={{ marginLeft: 12, fontSize: 12, color: "var(--muted-3)" }}>{r.count} legs</span>
                        {r.perLegInv > 0 && (
                          <span style={{ marginLeft: 12, fontSize: 12, color: "var(--muted-3)" }}>
                            Per leg: <b style={{ color: "var(--ink)" }}>{fmtCcy(r.perLegInv)}</b>
                          </span>
                        )}
                        <span style={{ marginLeft: 12, fontSize: 12, fontWeight: 600, color: r.combinedPnl >= 0 ? "#16a34a" : "#dc2626" }}>
                          Combined PnL: {fmtCcy(r.combinedPnl)}
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <TradeRow key={r.trade.id} t={r.trade} combined={r.combined} groupId={r.groupId} onDelete={deleteTrade} acctMap={acctMap} />
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>

        {pages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 2px", fontSize: 12, color: "var(--muted)" }}>
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

function TradeRow({ t, combined, groupId, onDelete, acctMap }) {
  const typeColor = t.option_type === "PUT" ? "#dc2626" : "#16a34a";
  const pnlColor = Number(t.net_booked_pnl) >= 0 ? "#16a34a" : "#dc2626";
  const monitorHref = combined ? `/monitor?group_id=${encodeURIComponent(groupId)}` : `/monitor?trade_id=${t.id}`;
  return (
    <tr style={combined ? { borderLeft: "4px solid #ddd6fe" } : undefined}>
      <td style={{ fontFamily: "var(--font-mono)", color: "var(--muted)", fontSize: 12 }}>{t.id}</td>
      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(t.entry_date)}</td>
      <td>
        <b>{t.token}</b>
        {combined && <div style={{ fontSize: 10, color: "var(--purple)" }}>leg</div>}
      </td>
      <td style={{ fontSize: 13, color: "var(--muted)" }}>{t.account_id && acctMap?.[t.account_id] ? acctMap[t.account_id] : "—"}</td>
      <td><span style={{ color: typeColor, fontWeight: 700, fontSize: 12 }}>{t.option_type}</span></td>
      <td>{t.options_strike || "—"}</td>
      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(t.expiry)}</td>
      <td>{t.days_to_expiry ?? "—"}</td>
      <td><span className={`pill ${t.status === "open" ? "pill-green" : "pill-grey"}`}>{t.status}</span></td>
      <td style={{ fontWeight: 500, color: "var(--ink)" }}>{fmtCcy(t.investment)}</td>
      <td style={{ color: Number(t.market_making_pl) >= 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>{fmtCcy(t.market_making_pl)}</td>
      <td style={{ color: pnlColor, fontWeight: 600 }}>{t.net_booked_pnl != null ? fmtCcy(t.net_booked_pnl) : "—"}</td>
      <td style={{ color: "var(--purple)", fontWeight: 600 }}>{t.apy != null ? Number(t.apy).toFixed(2) + "%" : "—"}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {combined
            ? <a href={`/combined-simulator?group=${encodeURIComponent(groupId)}`} className="btn-outline btn-outline-purple" style={{ textDecoration: "none" }}>Edit Combined</a>
            : <a href={`/add-strategy?id=${t.id}`} className="btn-outline" style={{ color: "var(--brand)", textDecoration: "none" }}>Edit / Close</a>}
          <a href={monitorHref} className="btn-outline btn-outline-green" style={{ textDecoration: "none" }}>Monitor</a>
          <a href="#" onClick={(e) => { e.preventDefault(); onDelete(t.id); }} className="btn-outline btn-outline-red" style={{ textDecoration: "none" }}>Delete</a>
        </div>
      </td>
    </tr>
  );
}

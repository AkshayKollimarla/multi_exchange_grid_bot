"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiDelete } from "@/lib/api";

const EXCHANGE_DOT = { binance: "#f0b90b", deribit: "#ff6b35", hyperliquid: "#7c3aed" };

function fmtWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function fmtCcy(v) {
  if (v == null || isNaN(v)) return "—";
  const n = Number(v);
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Toggle button that fetches round-trip stats on first click and shows them
// inline — from/to (a Stop History entry's own started_at/stopped_at) scope
// this to just that run; omitted (the "Currently Stopped" list) it's the
// bot_id slot's lifetime total.
function StatsToggle({ botId, from, to }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (stats || loading) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ botId });
      if (from && to) { qs.set("from", new Date(from).toISOString()); qs.set("to", new Date(to).toISOString()); }
      const j = await apiGet(`/api/round-trip-stats?${qs}`);
      setStats(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={toggle}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "var(--brand)", fontWeight: 600, padding: 0 }}
      >
        {open ? "▾" : "▸"} View Stats
      </button>
      {open && (
        <div style={{ marginTop: 6, fontSize: 12, display: "flex", gap: 14, color: "var(--muted)" }}>
          {loading && <span>Loading…</span>}
          {error && <span style={{ color: "var(--red)" }}>Error: {error}</span>}
          {stats && (
            <>
              <span>Round Trips: <b style={{ color: "var(--ink)" }}>{stats.count}</b></span>
              <span>Net PnL: <b style={{ color: stats.totalNetPnl >= 0 ? "#16a34a" : "#dc2626" }}>{fmtCcy(stats.totalNetPnl)}</b></span>
              <span>Gross PnL: <b style={{ color: stats.totalGrossPnl >= 0 ? "#16a34a" : "#dc2626" }}>{fmtCcy(stats.totalGrossPnl)}</b></span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function InactiveBotPage() {
  const [bots, setBots] = useState(null);
  const [history, setHistory] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [b, h, a] = await Promise.all([
        apiGet("/api/stopped-bots"),
        apiGet("/api/stopped-bots/history").catch(() => ({ history: [] })),
        apiGet("/api/accounts").catch(() => []),
      ]);
      setBots(b.bots || []);
      setHistory(h.history || []);
      setAccounts(Array.isArray(a) ? a : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  function accountName(accountId) {
    if (!accountId) return "Default (.env)";
    const acc = accounts.find((a) => String(a.id) === String(accountId));
    return acc?.name || `Account #${accountId}`;
  }

  async function handleDelete(botId) {
    if (!confirm(`Permanently remove ${botId} from Inactive Bots? This can't be undone.`)) return;
    setDeletingId(botId);
    try {
      await apiDelete(`/api/stopped-bots?botId=${encodeURIComponent(botId)}`);
      await refresh();
    } catch (e) {
      alert("Delete failed: " + e.message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      <div className="header">
        <div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div>
      </div>

      <section className="section">
        <div className="sec-head">⚪ Inactive Bot</div>

        {error && <div className="card"><div className="card-body" style={{ color: "var(--red)" }}>{error}</div></div>}
        {!error && bots == null && <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>}
        {!error && bots && bots.length === 0 && (
          <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>No stopped bots — manually stopped bots and bots that hit their upper/lower limit will show up here.</div></div>
        )}

        {bots && bots.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {bots.map((b) => (
              <div key={b.botId} className="card" style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--muted-2)" }} />
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: EXCHANGE_DOT[b.exchange] || "#888" }} />
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 }}>{b.config?.symbol || b.botId}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "capitalize" }}>
                    {b.exchange}{b.botId !== b.exchange ? ` · ${b.botId}` : ""}
                  </span>
                  <span className="pill pill-blue" style={{ textTransform: "none" }} title="Trading account">
                    👤 {accountName(b.config?.accountId)}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>Stopped {fmtWhen(b.stoppedAt)}</span>
                  {b.stopReason && <span style={{ fontSize: 12, color: "var(--red-2)" }} title={b.stopReason}>· {b.stopReason}</span>}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <Link
                      href={`/bot-configuration?restore=${encodeURIComponent(b.botId)}`}
                      className="btn"
                      style={{ height: 32, padding: "0 14px", fontSize: 12, background: "var(--brand)", color: "#fff", boxShadow: "none" }}
                    >
                      ✎ Edit
                    </Link>
                    <button
                      onClick={() => handleDelete(b.botId)}
                      disabled={deletingId === b.botId}
                      title="Permanently remove"
                      style={{
                        width: 32, height: 32, borderRadius: "50%", border: "none", cursor: "pointer",
                        background: "var(--red-soft)", color: "var(--red-2)", fontWeight: 800, fontSize: 14,
                        opacity: deletingId === b.botId ? 0.5 : 1,
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                <div style={{ marginTop: 8, paddingLeft: 29 }}>
                  <StatsToggle botId={b.botId} />
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="sec-head" style={{ marginTop: 28 }}>🕘 Stop History</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
          Every stop, manual or upper/lower-limit — stays here even after the bot has been edited and restarted.
        </div>

        {!error && history == null && <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>}
        {!error && history && history.length === 0 && (
          <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>No stop history yet.</div></div>
        )}

        {history && history.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {history.map((h, i) => (
              <div key={i} className="card" style={{ padding: "12px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: EXCHANGE_DOT[h.exchange] || "#888" }} />
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 }}>{h.config?.symbol || h.botId}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "capitalize" }}>
                    {h.exchange}{h.botId !== h.exchange ? ` · ${h.botId}` : ""}
                  </span>
                  <span className="pill pill-blue" style={{ textTransform: "none" }} title="Trading account">
                    👤 {accountName(h.config?.accountId)}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    {fmtWhen(h.startedAt)} → {fmtWhen(h.stoppedAt)}
                  </span>
                  {h.stopReason && <span style={{ fontSize: 12, color: "var(--red-2)" }} title={h.stopReason}>· {h.stopReason}</span>}
                </div>
                <div style={{ marginTop: 8, paddingLeft: 20 }}>
                  <StatsToggle botId={h.botId} from={h.startedAt} to={h.stoppedAt} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiDelete } from "@/lib/api";

const EXCHANGE_DOT = { binance: "#f0b90b", deribit: "#ff6b35", hyperliquid: "#7c3aed" };

function fmtWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function InactiveBotPage() {
  const [bots, setBots] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [b, a] = await Promise.all([
        apiGet("/api/stopped-bots"),
        apiGet("/api/accounts").catch(() => []),
      ]);
      setBots(b.bots || []);
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
              <div key={b.botId} className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
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
            ))}
          </div>
        )}
      </section>
    </>
  );
}

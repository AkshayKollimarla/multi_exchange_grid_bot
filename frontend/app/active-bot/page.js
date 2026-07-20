"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "@/lib/api";
import BotDetail from "@/components/BotDetail";

const EXCHANGE_DOT = { binance: "#f0b90b", deribit: "#ff6b35", hyperliquid: "#7c3aed" };

export default function ActiveBotPage() {
  const [bots, setBots] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [stoppingId, setStoppingId] = useState(null);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet("/api/status");
      setBots(data || {});
    } catch (e) { /* transient — next poll will retry */ }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const list = Object.entries(bots).map(([id, b]) => ({ id, ...b }));
  const running = list.filter((b) => b.running);

  // Keep the selection valid — default to the first running bot once data
  // loads, drop the selection if that bot stops existing.
  useEffect(() => {
    if (selectedId && bots[selectedId]) return;
    if (running.length > 0) setSelectedId(running[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  async function handleStop(botId) {
    if (!confirm(`Stop ${botId}? This cancels all its open orders.`)) return;
    setStoppingId(botId);
    try {
      await apiPost("/api/stop", { botId });
      await refresh();
    } catch (e) {
      alert("Stop failed: " + e.message);
    } finally {
      setStoppingId(null);
    }
  }

  const selected = selectedId ? bots[selectedId] : null;

  return (
    <>
      <div className="header">
        <div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div>
      </div>

      <section className="section">
        <div className="sec-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>🟢 Active Bot</span>
          <Link
            href="/bot-configuration"
            style={{
              fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, letterSpacing: "0.03em",
              color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", cursor: "pointer",
              background: "linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)",
              boxShadow: "0 4px 14px rgba(124,58,237,.35)", textDecoration: "none", display: "inline-block",
            }}
          >
            ⚡ New Bot
          </Link>
        </div>

        {list.length === 0 && (
          <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>No bots yet — click "New Bot" to launch one.</div></div>
        )}

        {list.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
            {list.map((b) => (
              <div
                key={b.id}
                onClick={() => setSelectedId(b.id)}
                className="card"
                style={{
                  cursor: "pointer", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12,
                  border: b.id === selectedId ? "1.5px solid var(--brand-2)" : undefined,
                }}
              >
                <span style={{
                  width: 9, height: 9, borderRadius: "50%",
                  background: b.running ? "var(--green)" : "var(--muted-2)",
                  boxShadow: b.running ? "0 0 0 3px rgba(22,163,74,.18)" : "none",
                }} />
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: EXCHANGE_DOT[b.exchangeKey] || "#888",
                }} />
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 }}>{b.label || b.id}</span>
                <span style={{ fontSize: 11, color: "var(--muted)", textTransform: "capitalize" }}>
                  {b.exchangeKey}{b.id !== b.exchangeKey ? ` · ${b.id}` : ""}
                </span>
                <span className="pill pill-blue" style={{ textTransform: "none" }} title="Trading account">
                  👤 {b.accountName || "Default (.env)"}
                </span>
                {b.running && b.lastPrice != null && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--muted)" }}>${b.lastPrice}</span>
                )}
                <span style={{ marginLeft: "auto" }}>
                  {b.running && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleStop(b.id); }}
                      disabled={stoppingId === b.id}
                      title="Stop this bot"
                      style={{
                        width: 26, height: 26, borderRadius: "50%", border: "none", cursor: "pointer",
                        background: "var(--red-soft)", color: "var(--red-2)", fontWeight: 800, fontSize: 13,
                        opacity: stoppingId === b.id ? 0.5 : 1,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {selected && <BotDetail bot={selected} />}
      </section>
    </>
  );
}

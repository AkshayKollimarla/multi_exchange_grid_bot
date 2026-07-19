"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";

const EXCHANGE_DOT = { binance: "#f0b90b", deribit: "#ff6b35", hyperliquid: "#7c3aed" };

export default function BotLogsPage() {
  const [bots, setBots] = useState({});
  const [selectedId, setSelectedId] = useState(""); // "" = all bots combined
  const [logs, setLogs] = useState([]);
  const pollRef = useRef(null);

  const refreshBots = useCallback(async () => {
    try {
      const data = await apiGet("/api/status");
      setBots(data || {});
    } catch (e) { /* transient — next poll will retry */ }
  }, []);

  const refreshLogs = useCallback(async () => {
    try {
      const qs = selectedId ? `?botId=${encodeURIComponent(selectedId)}` : "";
      const data = await apiGet(`/api/logs${qs}`);
      setLogs(Array.isArray(data) ? data : []);
    } catch (e) { /* transient — next poll will retry */ }
  }, [selectedId]);

  useEffect(() => {
    refreshBots();
    const t = setInterval(refreshBots, 8000);
    return () => clearInterval(t);
  }, [refreshBots]);

  useEffect(() => {
    refreshLogs();
    clearInterval(pollRef.current);
    pollRef.current = setInterval(refreshLogs, 3000);
    return () => clearInterval(pollRef.current);
  }, [refreshLogs]);

  const list = Object.entries(bots).map(([id, b]) => ({ id, ...b }));

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">📜 Bot Logs</div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <button
              className="btn-refresh"
              onClick={() => setSelectedId("")}
              style={selectedId === "" ? { background: "var(--ink)", color: "#fff", borderColor: "var(--ink)" } : undefined}
            >
              All bots
            </button>
            {list.map((b) => (
              <button
                key={b.id}
                className="btn-refresh"
                onClick={() => setSelectedId(b.id)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7,
                  ...(selectedId === b.id ? { background: "var(--ink)", color: "#fff", borderColor: "var(--ink)" } : {}),
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: b.running ? "var(--green)" : "var(--muted-2)" }} />
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: EXCHANGE_DOT[b.exchangeKey] || "#888" }} />
                {b.label || b.id}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header">📜 Bot Logs {selectedId ? `— ${bots[selectedId]?.label || selectedId}` : "(current exchange)"}</div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="log-feed">
              {logs.length === 0 && (
                <div className="log-line"><span className="log-time">--:--:--</span><span className="log-text">Waiting for bot…</span></div>
              )}
              {logs.map((entry, i) => (
                <div className="log-line" key={i}>
                  <span className="log-time">{new Date(entry.ts).toLocaleTimeString()}</span>
                  <span className={`log-text ${entry.level}`}>{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

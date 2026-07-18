"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtCcy, fmtDate } from "@/lib/format";
import { strikeNumber } from "@/lib/blackScholes";
import { renderPayoffSvg } from "@/lib/payoffChart";

const OPT_FIELDS = [
  ["token", "Token", "text"], ["option_type", "Option Type", "text"], ["options_strike", "Strike Price", "text"],
  ["expiry", "Expiry Date", "date"], ["entry_date", "Entry Date", "date"], ["end_date", "Exit Date", "date"],
  ["status", "Status", "text"], ["investment", "Investment", "currency"],
  ["opt_entry_qty", "Opt Entry Qty", "number"], ["opt_entry_price", "Opt Entry Price", "currency"], ["opt_exit_price", "Opt Exit Price", "currency"],
  ["fut_qty", "Fut Qty", "number"], ["fut_entry_price", "Fut Entry Price", "currency"], ["fut_exit_price", "Fut Exit Price", "currency"],
  ["upside_distance", "Upside Distance", "number"], ["down_distance", "Down Distance", "number"],
  ["basket_distance", "Basket Distance", "number"], ["basket_loss", "Basket Loss", "currency"],
  ["total_baskets", "Total Baskets", "number"], ["total_mm_loss", "Total MM Loss", "currency"],
  ["net_booked_pnl", "Net Booked PNL", "currency"], ["market_making_pl", "Market Making PL", "currency"],
];

function baseToken(token) { return token ? token.split("-")[0] : "—"; }
function toInputDate(d) {
  if (!d) return "";
  const s = String(d);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export default function OptionsAnalysisPage() {
  const [allTrades, setAllTrades] = useState([]);
  const [symbol, setSymbol] = useState("all");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [trade, setTrade] = useState(null);
  const [loadingTrade, setLoadingTrade] = useState(false);
  const [payoffS, setPayoffS] = useState("");
  const [payoffIv, setPayoffIv] = useState("30");

  useEffect(() => {
    apiGet("/api/options-db/trades?limit=9999")
      .then((j) => setAllTrades(j.trades || []))
      .catch(() => setAllTrades([]));
  }, []);

  const symbols = useMemo(
    () => [...new Set(allTrades.map((t) => baseToken(t.token)).filter(Boolean))].sort(),
    [allTrades]
  );

  const filtered = useMemo(() => allTrades.filter((t) => {
    if (symbol !== "all" && baseToken(t.token) !== symbol) return false;
    if (status !== "all" && t.status !== status) return false;
    const d = t.entry_date ? toInputDate(t.entry_date) : null;
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    return true;
  }), [allTrades, symbol, status, from, to]);

  // If the current selection drops out of the filtered list, clear the detail view.
  useEffect(() => {
    if (selectedId && !filtered.some((t) => String(t.id) === selectedId)) {
      setSelectedId("");
      setTrade(null);
    }
  }, [filtered, selectedId]);

  useEffect(() => {
    if (!selectedId) { setTrade(null); return; }
    setLoadingTrade(true);
    apiGet(`/api/options-db/trades/${selectedId}`)
      .then((j) => { setTrade(j.trade); setPayoffS(""); setPayoffIv("30"); })
      .catch(() => setTrade(null))
      .finally(() => setLoadingTrade(false));
  }, [selectedId]);

  const runningDates = useMemo(() => {
    if (!trade) return [];
    const dateFrom = trade.entry_date ? toInputDate(trade.entry_date) : null;
    const dateTo = trade.end_date ? toInputDate(trade.end_date) : null;
    if (!dateFrom || !dateTo) return [];
    const out = [];
    const start = new Date(dateFrom + "T00:00:00"), end = new Date(dateTo + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    return out;
  }, [trade]);

  const payoff = useMemo(() => {
    if (!trade || !trade.options_strike) return null;
    return renderPayoffSvg(trade, payoffS, payoffIv);
  }, [trade, payoffS, payoffIv]);

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">🔍 Options Analysis</div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-body">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 12 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Symbol</label>
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                  <option value="all">All Symbols</option>
                  {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Status</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">All</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="field" style={{ margin: 0 }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Select Strategy</label>
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                <option value="">— Select a strategy —</option>
                {filtered.map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.id} · {t.token} · {t.option_type} · {fmtDate(t.entry_date)} → {fmtDate(t.end_date)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {loadingTrade && <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</p>}

        {trade && !loadingTrade && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div className="pnl-card pnl-neutral"><div className="stat-label">DATE</div><div className="stat-value">{fmtDate(trade.entry_date)}</div></div>
              <div className="pnl-card pnl-neutral"><div className="stat-label">TOKEN</div><div className="stat-value blue" style={{ fontSize: 20 }}>{baseToken(trade.token)}</div></div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div className="card">
                <div className="card-header">📅 Strategy Running Days</div>
                <div className="card-body">
                  {runningDates.length === 0
                    ? <p style={{ color: "var(--muted)", fontSize: 12 }}>Set entry date and end date to see running days.</p>
                    : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {runningDates.map((d) => (
                          <span key={d} style={{ border: "1px solid var(--border)", background: "var(--surface-2)", padding: "4px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>{fmtDate(d)}</span>
                        ))}
                      </div>
                    )}
                </div>
              </div>
              <div className="card">
                <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 14, justifyContent: "center" }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#0d9488", textTransform: "uppercase" }}>Option Entry Date</div>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{fmtDate(trade.entry_date)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "#0d9488", textTransform: "uppercase" }}>Option Exit Date</div>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{fmtDate(trade.end_date)}</div>
                  </div>
                </div>
              </div>
            </div>

            {trade.options_strike && (
              <div className="card" style={{ marginBottom: 12 }}>
                <div className="card-header">📈 Payoff Chart at Expiry</div>
                <div className="card-body">
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginBottom: 10 }}>
                    <div className="field" style={{ margin: 0 }}>
                      <label>Current Underlying Price</label>
                      <input type="number" step="any" placeholder={String(strikeNumber(trade.options_strike))} value={payoffS} onChange={(e) => setPayoffS(e.target.value)} />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <label>Implied Volatility (%)</label>
                      <input type="number" step="0.5" value={payoffIv} onChange={(e) => setPayoffIv(e.target.value)} />
                    </div>
                    {payoff?.note && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: payoff.note.positive ? "var(--green)" : "var(--red)" }}>
                        {payoff.note.text}
                      </div>
                    )}
                  </div>
                  {payoff && <div dangerouslySetInnerHTML={{ __html: payoff.svg }} />}
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-header">📄 Option Details</div>
              <div className="card-body">
                {OPT_FIELDS.map(([key, label, fmt]) => {
                  const raw = trade[key];
                  let v;
                  if (fmt === "date") v = fmtDate(raw);
                  else if (fmt === "currency") v = fmtCcy(raw);
                  else if (fmt === "number") v = raw != null && raw !== "" ? Number(raw).toFixed(4) : "—";
                  else v = raw != null && raw !== "" ? String(raw) : "—";
                  return (
                    <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px dashed var(--border)" }}>
                      <span style={{ color: "var(--muted)", fontSize: 12 }}>{label}</span>
                      <span style={{ fontWeight: 700, fontSize: 12 }}>{v}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}

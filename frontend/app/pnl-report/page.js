"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtCcy } from "@/lib/format";

const PERIODS = [
  { key: "24h", label: "24 Hours" },
  { key: "7d", label: "7 Days" },
  { key: "30d", label: "30 Days" },
  { key: "custom", label: "Custom" },
];

export default function PnlReportPage() {
  const [period, setPeriod] = useState("24h");
  const [exchange, setExchange] = useState("all");
  const [symbol, setSymbol] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  const queryString = useCallback(() => {
    let qs = `period=${period}`;
    if (exchange !== "all") qs += `&exchange=${encodeURIComponent(exchange)}`;
    if (symbol !== "all") qs += `&symbol=${encodeURIComponent(symbol)}`;
    if (period === "custom") {
      if (!from || !to) return null;
      qs += `&from=${new Date(from).getTime()}&to=${new Date(to).getTime() + 86400000}`;
    }
    return qs;
  }, [period, exchange, symbol, from, to]);

  const load = useCallback(() => {
    const qs = queryString();
    if (!qs) return;
    apiGet(`/api/db_report?${qs}`)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message));
  }, [queryString]);

  useEffect(load, [period, exchange, symbol, from, to]);

  function handleExchangeChange(v) {
    setExchange(v);
    // Coin list is exchange-scoped server-side; reset the coin filter if the
    // account changed, same as the classic dashboard's onReportExchangeChange.
    setSymbol("all");
  }

  function downloadCsv() {
    const qs = queryString();
    if (!qs) { alert("Please pick a custom date range first."); return; }
    const base = process.env.NEXT_PUBLIC_API_BASE || "";
    window.location.href = `${base}/api/csv?${qs}`;
  }

  const symbols = data?.symbols || [];
  const exchanges = data?.exchanges || [];
  const rts = data?.roundTrips || [];

  const labelParts = [];
  if (exchange !== "all") labelParts.push(exchange.charAt(0).toUpperCase() + exchange.slice(1));
  if (symbol !== "all") labelParts.push(symbol);
  const label = labelParts.length ? labelParts.join(" · ") : "All Exchanges";

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">📈 PnL Report</div>

        <div className="card">
          <div className="card-header">
            <div className="card-header-row">
              <span>📈 PnL Report <span className="pill pill-blue" style={{ marginLeft: 8 }}>{label}</span></span>
              <button onClick={downloadCsv} className="btn-refresh">📥 Download CSV</button>
            </div>
          </div>
          <div className="card-body">
            <div className="tab-row">
              {PERIODS.map((p) => (
                <button key={p.key} className={`tab-btn${period === p.key ? " active" : ""}`} onClick={() => setPeriod(p.key)}>{p.label}</button>
              ))}
              <select
                value={exchange} onChange={(e) => handleExchangeChange(e.target.value)}
                title="Filter report by account/exchange"
                style={{ marginLeft: "auto", background: "var(--surface-2)", color: "var(--ink)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                <option value="all">All accounts</option>
                {exchanges.map((e) => <option key={e} value={e}>{e.charAt(0).toUpperCase() + e.slice(1)}</option>)}
              </select>
              <select
                value={symbol} onChange={(e) => setSymbol(e.target.value)}
                title="Filter report by coin"
                style={{ background: "var(--surface-2)", color: "var(--ink)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
              >
                <option value="all">All coins</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {period === "custom" && (
              <div className="custom-date-row visible">
                <label>From: <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                <label>To: <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
                <button className="tab-btn" onClick={load}>Apply</button>
              </div>
            )}

            {error && <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 12 }}>Error: {error}</div>}

            <div className="rep-grid">
              <RepStat label="Gross PnL" value={data ? (data.pnl >= 0 ? "+" : "") + Number(data.pnl || 0).toFixed(4) : "—"} cls={data ? (data.pnl > 0 ? "pos" : data.pnl < 0 ? "neg" : "") : ""} />
              <RepStat label="Round Trips" value={data?.count ?? 0} />
              <RepStat label="PnL/RT" value={data?.perRtPnl ? `+$${Number(data.perRtPnl).toFixed(4)}` : "—"} />
              <RepStat label="Avg Spread" value={data?.avgSpread ? `$${Number(data.avgSpread).toFixed(4)}` : "—"} />
              <RepStat label="Fees" value={"-$" + Number(data?.totalFees || 0).toFixed(4)} cls="neg" />
              <RepStat label="Net PnL" value={fmtCcy(data?.netPnl)} />
              <RepStat label="Buys" value={data?.periodBuys ?? "—"} />
              <RepStat label="Sells" value={data?.periodSells ?? "—"} />
              <RepStat label="Win Rate" value={data?.count ? `${data.winRate}%` : "—"} />
            </div>

            <table className="ord-table">
              <thead><tr><th>Side</th><th>Symbol</th><th>Buy</th><th>Sell</th><th>Qty</th><th>Fee</th><th>Net PnL</th><th>Closed</th></tr></thead>
              <tbody>
                {rts.length === 0
                  ? <tr><td colSpan={8} className="empty-td">No round trips in this period</td></tr>
                  : rts.map((r, i) => (
                    <tr key={i}>
                      <td style={{ color: r.openSide === "BUY" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{r.openSide}</td>
                      <td>{r.symbol}</td>
                      <td>${r.buyPrice}</td>
                      <td>${r.sellPrice}</td>
                      <td>{r.qty}</td>
                      <td>{fmtCcy(r.totalFee)}</td>
                      <td style={{ color: r.netPnl >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{fmtCcy(r.netPnl)}</td>
                      <td>{new Date(r.closeTs).toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

function RepStat({ label, value, cls }) {
  return (
    <div className="rep-stat">
      <div className="rep-label">{label}</div>
      <div className={`rep-value${cls ? " " + cls : ""}`}>{value}</div>
    </div>
  );
}

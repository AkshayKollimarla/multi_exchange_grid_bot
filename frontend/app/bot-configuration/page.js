"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { loadSymbolsFor } from "@/lib/symbols";
import { fmtCcy } from "@/lib/format";

const PRICE_SOURCES = [
  { value: "binance_spot", label: "Binance Spot", exchange: "binance" },
  { value: "binance_futures", label: "Binance Futures (USDT-M)", exchange: "binance" },
  { value: "binance_coinm", label: "Binance Coin-M", exchange: "binance" },
  { value: "deribit", label: "Deribit Perpetual", exchange: "deribit" },
  { value: "deribit_spot", label: "Deribit Spot", exchange: "deribit" },
  { value: "hyperliquid", label: "Hyperliquid Perpetual", exchange: "hyperliquid" },
  { value: "hyperliquid_spot", label: "Hyperliquid Spot", exchange: "hyperliquid" },
];

const ENV_KEYS_NOTE = {
  binance: "BINANCE_API_KEY, BINANCE_SECRET_KEY",
  deribit: "DERIBIT_CLIENT_ID, DERIBIT_CLIENT_SECRET",
  hyperliquid: "HYPERLIQUID_WALLET_ADDRESS, HYPERLIQUID_PRIVATE_KEY",
};

const emptyForm = {
  priceSource: "binance_spot", accountId: "", symbol: "",
  distance: "", avgSellSpacing: "", avgBuySpacing: "", targetSpread: "", qtyPerStep: "",
};

export default function BotConfigurationPage() {
  const [form, setForm] = useState(emptyForm);
  const [accounts, setAccounts] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState(null);

  const exchange = PRICE_SOURCES.find((p) => p.value === form.priceSource)?.exchange || "binance";

  useEffect(() => {
    apiGet("/api/accounts").then((list) => setAccounts(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSymbolsLoading(true);
    setSymbols([]);
    setForm((f) => ({ ...f, symbol: "" }));
    setSymbolQuery("");
    apiGet("/api/config")
      .then((cfg) => loadSymbolsFor(form.priceSource, cfg))
      .then((list) => { if (!cancelled) setSymbols(list); })
      .catch(() => { if (!cancelled) setSymbols([]); })
      .finally(() => { if (!cancelled) setSymbolsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.priceSource]);

  const filteredSymbols = symbolQuery
    ? symbols.filter((s) => {
        const q = symbolQuery.toUpperCase();
        // Match both forms — many Hyperliquid spot pairs (e.g. HYPE/USDC)
        // have an opaque native id like "@107" instead of a readable
        // ticker, so searching "hyp" only works against ccxt ("HYPE/USDC").
        return s.ccxt.toUpperCase().includes(q) || s.native.toUpperCase().includes(q);
      }).slice(0, 40)
    : symbols.slice(0, 40);

  function setField(key, value) { setForm((f) => ({ ...f, [key]: value })); }

  async function handleStart() {
    if (!form.symbol) { setMsg({ ok: false, text: "Pick a symbol from the dropdown." }); return; }
    if (!form.distance) { setMsg({ ok: false, text: "Distance is required." }); return; }
    setMsg(null);
    setStarting(true);
    try {
      const body = {
        priceSource: form.priceSource, symbol: form.symbol, distance: form.distance,
        avgSellSpacing: form.avgSellSpacing, avgBuySpacing: form.avgBuySpacing,
        targetSpread: form.targetSpread, qtyPerStep: form.qtyPerStep,
      };
      if (form.accountId) body.accountId = form.accountId;
      const data = await apiPost("/api/start", body);
      setMsg({ ok: true, text: `✓ Started — botId "${data.botId}". Upper $${data.upperLimit} · Lower $${data.lowerLimit}. See it on the Active Bot page.` });
      setForm(emptyForm);
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">⚙️ Bot Configuration</div>
        <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 20, alignItems: "start" }}>
          <div className="card">
            <div className="card-header">New Bot</div>
            <div className="card-body">
              <div className="note">
                ⚠ API keys are read from your .env file — not entered here.<br />
                Need: <code>{ENV_KEYS_NOTE[exchange]}</code>
              </div>

              <div className="section-title">Exchange</div>
              <div className="field">
                <label>Price Source</label>
                <select value={form.priceSource} onChange={(e) => setField("priceSource", e.target.value)} disabled={starting}>
                  {PRICE_SOURCES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              {accounts.length > 0 && (
                <div className="field">
                  <label>Account</label>
                  <select value={form.accountId} onChange={(e) => setField("accountId", e.target.value)} disabled={starting}>
                    <option value="">Default (.env keys)</option>
                    {accounts.filter((a) => a.exchange === exchange).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <div className="hint">Trades run on the selected account. Manage accounts in the <b>Accounts</b> tab.</div>
                </div>
              )}
              <div className="field">
                <label>Symbol</label>
                <input
                  type="text"
                  placeholder={symbolsLoading ? "Loading symbols…" : `Search ${symbols.length} symbols…`}
                  value={form.symbol || symbolQuery}
                  onChange={(e) => { setSymbolQuery(e.target.value); setField("symbol", ""); }}
                  disabled={starting}
                />
                {!form.symbol && symbolQuery && (
                  <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border-2)", borderRadius: "var(--r-md)", marginTop: 6 }}>
                    {filteredSymbols.length === 0
                      ? <div style={{ padding: 10, fontSize: 12, color: "var(--muted)" }}>No matches.</div>
                      : filteredSymbols.map((s) => (
                        <div
                          key={s.ccxt}
                          onClick={() => { setField("symbol", s.ccxt); setSymbolQuery(s.native); }}
                          style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "var(--brand-soft)"}
                          onMouseLeave={(e) => e.currentTarget.style.background = ""}
                        >
                          {s.native}
                        </div>
                      ))}
                  </div>
                )}
              </div>

              <div className="section-title">Grid Parameters</div>
              <div className="field"><label>Distance ($)</label><input type="number" step="0.01" placeholder="e.g. 10" value={form.distance} onChange={(e) => setField("distance", e.target.value)} disabled={starting} /></div>
              <div className="row-2">
                <div className="field"><label>Sell Spacing ($)</label><input type="number" step="0.01" placeholder="e.g. 1" value={form.avgSellSpacing} onChange={(e) => setField("avgSellSpacing", e.target.value)} disabled={starting} /></div>
                <div className="field"><label>Buy Spacing ($)</label><input type="number" step="0.01" placeholder="e.g. 1" value={form.avgBuySpacing} onChange={(e) => setField("avgBuySpacing", e.target.value)} disabled={starting} /></div>
              </div>
              <div className="field"><label>Target Spread ($)</label><input type="number" step="0.01" placeholder="e.g. 0.5" value={form.targetSpread} onChange={(e) => setField("targetSpread", e.target.value)} disabled={starting} /></div>
              <div className="field"><label>Quantity Per Step</label><input type="number" step="0.001" placeholder="e.g. 0.1" value={form.qtyPerStep} onChange={(e) => setField("qtyPerStep", e.target.value)} disabled={starting} /></div>

              {msg && <div style={{ fontSize: 12, marginBottom: 10, color: msg.ok === false ? "var(--red)" : "var(--green)" }}>{msg.text}</div>}
              <button className="btn btn-start" style={{ width: "100%" }} onClick={handleStart} disabled={starting}>
                {starting ? "Starting…" : "▶ Start Bot"}
              </button>
              <div className="hint" style={{ marginTop: 10 }}>
                Advanced options (Binance futures hedge, Hyperliquid HIP-3 dex) aren't on this simplified form yet — use the <a href="/index.html">classic dashboard</a> for those.
              </div>
            </div>
          </div>

          <AccountOverview exchange={exchange} />
        </div>
      </section>
    </>
  );
}

function AccountOverview({ exchange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setData(null); setError(null); }, [exchange]);

  function refresh() {
    setLoading(true); setError(null);
    const path = exchange === "hyperliquid" ? "/api/hl_portfolio"
      : exchange === "deribit" ? "/api/portfolio?exchange=deribit"
      : "/api/account";
    apiGet(path)
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-header-row">
          <span>{exchange === "binance" ? "🟦" : exchange === "deribit" ? "🟧" : "🟣"} {exchange.charAt(0).toUpperCase() + exchange.slice(1)} Account Overview</span>
          <button onClick={refresh} className="btn-refresh" disabled={loading}>↻ {loading ? "Loading…" : "Refresh"}</button>
        </div>
      </div>
      <div className="card-body">
        {error && <div style={{ color: "var(--red)", fontSize: 13 }}>{error}</div>}
        {!data && !error && <div className="timestamp-note">Not loaded yet — click Refresh</div>}

        {data && exchange === "binance" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
            <Stat label="Spot Balance" value={fmtCcy(data.spotFdusd)} />
            <Stat label="Spot Coin Value" value={fmtCcy(data.spotSolValue)} />
            <Stat label="Futures Balance" value={fmtCcy(data.futuresBalance)} />
            <Stat label="Futures uPnL" value={fmtCcy(data.futuresUnrealizedPnl)} />
            <Stat label="Total Portfolio" value={fmtCcy(data.totalUsd)} cls="blue" big />
          </div>
        )}

        {data && exchange === "hyperliquid" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
            <Stat label="Perps USDC (Free)" value={fmtCcy(data.perpFree)} />
            <Stat label="Perps USDC (Total)" value={fmtCcy(data.perpTotal)} />
            <Stat label="Spot USDC" value={fmtCcy(data.spotUsdc)} />
            <Stat label="Combined USDC" value={fmtCcy(data.combined)} cls="blue" big />
          </div>
        )}

        {data && exchange === "deribit" && (
          <pre style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, whiteSpace: "pre-wrap", color: "var(--ink-2)", lineHeight: 1.7 }}>
            {(data.text || "").replace(/<\/?[^>]+>/g, "")}
          </pre>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, cls, big }) {
  return (
    <div className="pnl-card pnl-neutral" style={big ? { borderTop: "3px solid var(--brand)" } : undefined}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${cls ? " " + cls : ""}`} style={big ? { fontSize: 24 } : undefined}>{value}</div>
    </div>
  );
}

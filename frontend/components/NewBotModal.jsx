"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { loadSymbolsFor } from "@/lib/symbols";

const PRICE_SOURCES = [
  { value: "binance_spot", label: "Binance Spot" },
  { value: "binance_futures", label: "Binance Futures (USDT-M)" },
  { value: "binance_coinm", label: "Binance Coin-M" },
  { value: "deribit", label: "Deribit Perpetual" },
  { value: "deribit_spot", label: "Deribit Spot" },
  { value: "hyperliquid", label: "Hyperliquid Perpetual" },
  { value: "hyperliquid_spot", label: "Hyperliquid Spot" },
];

const emptyForm = {
  priceSource: "binance_spot",
  accountId: "",
  symbol: "",
  distance: "",
  avgSellSpacing: "",
  avgBuySpacing: "",
  targetSpread: "",
  qtyPerStep: "",
};

// Simplified New Bot form — core fields only (price source, account, symbol,
// grid parameters). Binance futures hedge and Hyperliquid HIP-3 dex configs
// are advanced/rare enough that they stay on the classic dashboard for now
// rather than adding weight to this "simple" flow.
export default function NewBotModal({ onClose, onStarted }) {
  const [form, setForm] = useState(emptyForm);
  const [accounts, setAccounts] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [symbolsLoading, setSymbolsLoading] = useState(false);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

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
    ? symbols.filter((s) => s.native.toUpperCase().includes(symbolQuery.toUpperCase())).slice(0, 40)
    : symbols.slice(0, 40);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleStart() {
    if (!form.symbol) { setError("Pick a symbol from the dropdown."); return; }
    if (!form.distance) { setError("Distance is required."); return; }
    setError(null);
    setStarting(true);
    try {
      const body = {
        priceSource: form.priceSource,
        symbol: form.symbol,
        distance: form.distance,
        avgSellSpacing: form.avgSellSpacing,
        avgBuySpacing: form.avgBuySpacing,
        targetSpread: form.targetSpread,
        qtyPerStep: form.qtyPerStep,
      };
      if (form.accountId) body.accountId = form.accountId;
      const data = await apiPost("/api/start", body);
      onStarted(data.botId);
    } catch (e) {
      setError(e.message);
      setStarting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(11,18,32,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ width: 480, maxHeight: "88vh", overflowY: "auto" }}>
        <div className="card-header">
          <div className="card-header-row">
            <span>⚡ New Bot</span>
            <button className="btn-refresh" onClick={onClose} disabled={starting}>✕ Close</button>
          </div>
        </div>
        <div className="card-body">
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
                {accounts.filter((a) => a.exchange === priceSourceExchange(form.priceSource)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
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
              <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border-2)", borderRadius: "var(--r-md)", marginTop: 6 }}>
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

          <div className="field"><label>Distance ($)</label><input type="number" step="0.01" placeholder="e.g. 10" value={form.distance} onChange={(e) => setField("distance", e.target.value)} disabled={starting} /></div>
          <div className="row-2">
            <div className="field"><label>Sell Spacing ($)</label><input type="number" step="0.01" placeholder="e.g. 1" value={form.avgSellSpacing} onChange={(e) => setField("avgSellSpacing", e.target.value)} disabled={starting} /></div>
            <div className="field"><label>Buy Spacing ($)</label><input type="number" step="0.01" placeholder="e.g. 1" value={form.avgBuySpacing} onChange={(e) => setField("avgBuySpacing", e.target.value)} disabled={starting} /></div>
          </div>
          <div className="field"><label>Target Spread ($)</label><input type="number" step="0.01" placeholder="e.g. 0.5" value={form.targetSpread} onChange={(e) => setField("targetSpread", e.target.value)} disabled={starting} /></div>
          <div className="field"><label>Quantity Per Step</label><input type="number" step="0.001" placeholder="e.g. 0.1" value={form.qtyPerStep} onChange={(e) => setField("qtyPerStep", e.target.value)} disabled={starting} /></div>

          {error && <div style={{ color: "var(--red)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

          <button className="btn btn-start" style={{ width: "100%" }} onClick={handleStart} disabled={starting}>
            {starting ? "Starting…" : "▶ Start Bot"}
          </button>
        </div>
      </div>
    </div>
  );
}

function priceSourceExchange(priceSource) {
  if (priceSource.startsWith("binance")) return "binance";
  if (priceSource.startsWith("deribit")) return "deribit";
  return "hyperliquid";
}

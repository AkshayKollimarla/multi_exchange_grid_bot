"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { bsPrice, strikeNumber } from "@/lib/blackScholes";
import { computeDerived, toInputDate } from "@/lib/optionsDerived";
import { tokensFor, expiriesFor, strikesFor, findInstrument } from "@/lib/deribitLiveChain";

const FIELD_KEYS = [
  "entry_date", "token", "option_type", "investment", "status", "end_date",
  "options_strike", "expiry", "opt_entry_qty", "opt_entry_price", "opt_exit_price",
  "fut_qty", "fut_entry_price", "fut_exit_price", "upside_distance", "down_distance",
  "basket_distance", "basket_loss", "net_booked_pnl", "market_making_pl",
];

function emptyForm() {
  return {
    entry_date: new Date().toISOString().slice(0, 10), token: "", option_type: "PUT",
    investment: "", status: "open", end_date: "",
    options_strike: "", expiry: "", opt_entry_qty: "", opt_entry_price: "", opt_exit_price: "",
    fut_qty: "", fut_entry_price: "", fut_exit_price: "",
    upside_distance: "", down_distance: "", basket_distance: "", basket_loss: "",
    net_booked_pnl: "", market_making_pl: "",
  };
}
function tradeToForm(t) {
  const f = emptyForm();
  for (const k of FIELD_KEYS) if (t[k] != null) f[k] = k.endsWith("date") || k === "expiry" ? toInputDate(t[k]) : t[k];
  f.option_type = t.option_type || "PUT";
  f.status = t.status || "open";
  return f;
}

function CalcRow({ label, val, big, signed, loss }) {
  const n = Number(String(val).replace(/[^0-9.-]/g, ""));
  const isNum = !isNaN(n) && val !== "—";
  const color = loss ? "var(--red-2)" : signed && isNum ? (n >= 0 ? "var(--green-2)" : "var(--red-2)") : "var(--ink)";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: big ? "6px 0" : "4px 0", borderBottom: "1px dashed var(--border)" }}>
      <span style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: ".04em", fontSize: big ? 11 : 10.5, fontWeight: big ? 700 : 600, color: big ? "var(--ink-2)" : "var(--muted)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: big ? 14 : 12.5, fontWeight: 700, color, whiteSpace: "nowrap" }}>{val}</span>
    </div>
  );
}
function CalcGroup({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color: "var(--muted)", letterSpacing: ".07em", marginBottom: 6, paddingBottom: 5, borderBottom: "1px solid var(--border)" }}>{title}</div>
      {children}
    </div>
  );
}
function fmtCcyOrDash(v) {
  if (v == null || isNaN(v)) return "—";
  const n = Number(v);
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNumOrDash(v, dec = 2) {
  if (v == null || isNaN(v)) return "—";
  return Number(v).toFixed(dec);
}

// Mirrors server.js's deribitTickSizeFor/deribitRoundToStep exactly, so the
// confirmation modal shows the price that will ACTUALLY be submitted —
// Deribit rejects any price that isn't an exact multiple of the
// instrument's tick_size (e.g. 0.2 below $50 on some USDC options).
function tickSizeFor(inst, price) {
  let tick = inst.tick_size;
  if (Array.isArray(inst.tick_size_steps)) {
    for (const step of [...inst.tick_size_steps].sort((a, b) => a.above_price - b.above_price)) {
      if (price >= step.above_price) tick = step.tick_size;
    }
  }
  return tick;
}
function roundToTick(price, inst) {
  const tick = tickSizeFor(inst, price);
  return tick ? Number((Math.round(price / tick) * tick).toFixed(10)) : price;
}

function AddStrategyInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const idParam = searchParams.get("id");

  const [form, setForm] = useState(emptyForm);
  const [manualToken, setManualToken] = useState("");
  const [iv, setIv] = useState("");
  const [editId, setEditId] = useState(null);
  const [instruments, setInstruments] = useState([]);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const fetchSeq = useRef(0);

  useEffect(() => {
    apiGet("/api/deribit/instruments").then((list) => setInstruments(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  const loadTrade = useCallback(async (id) => {
    setMsg(null);
    try {
      const j = await apiGet(`/api/options-db/trades/${id}`);
      const t = j.trade;
      setForm(tradeToForm(t));
      setIv("");
      setEditId(id);
      const isLiveToken = tokensFor(instruments).includes(t.token);
      if (!isLiveToken && t.token) setManualToken(t.token);
      else setManualToken("");
    } catch (e) {
      setMsg({ ok: false, text: "Load failed: " + e.message });
    }
  }, [instruments]);

  useEffect(() => {
    if (idParam) loadTrade(idParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idParam, instruments.length > 0]);

  function resetForm() {
    setForm(emptyForm());
    setManualToken("");
    setIv("");
    setEditId(null);
    setMsg(null);
    setNote("");
    router.replace("/add-strategy");
  }

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const isOther = form.token === "__other__";
  const tokens = useMemo(() => tokensFor(instruments), [instruments]);
  const expiries = useMemo(
    () => (form.token && !isOther ? expiriesFor(instruments, form.token) : []),
    [instruments, form.token, isOther]
  );
  const strikes = useMemo(
    () => (form.token && form.expiry && !isOther ? strikesFor(instruments, form.token, form.expiry, form.option_type) : []),
    [instruments, form.token, form.expiry, form.option_type, isOther]
  );

  async function fetchLivePrice(token, expiry, type, strike) {
    if (!token || token === "__other__" || !expiry || !strike) return;
    const inst = findInstrument(instruments, token, expiry, type, strike);
    if (!inst) { setNote("Not in the live chain (using saved value)."); return; }
    const seq = ++fetchSeq.current;
    setForm((f) => ({ ...f, opt_entry_price: "" }));
    setIv("");
    setNote("Fetching live price/IV…");
    try {
      const t = await apiGet(`/api/deribit/ticker?instrument=${encodeURIComponent(inst.instrument_name)}`);
      if (seq !== fetchSeq.current) return; // superseded by a later selection
      const index = Number(t.index_price ?? t.underlying_price) || 0;
      const rawMark = Number(t.mark_price) || 0;
      const markUsd = inst.settlement === "coin" ? rawMark * index : rawMark;
      if (markUsd) setForm((f) => ({ ...f, opt_entry_price: markUsd.toFixed(4), fut_entry_price: f.fut_entry_price || (index ? index.toFixed(4) : f.fut_entry_price) }));
      if (t.mark_iv != null) setIv(Number(t.mark_iv).toFixed(1));
      const settleTag = inst.settlement === "coin" ? " (coin-settled)" : "";
      setNote(`${inst.instrument_name}${settleTag} · mark $${markUsd.toFixed(4)} · IV ${Number(t.mark_iv || 0).toFixed(1)}% · index $${index.toFixed(2)}`);
    } catch (e) {
      if (seq === fetchSeq.current) setNote("Live fetch failed: " + e.message);
    }
  }

  function handleTokenChange(v) {
    setForm((f) => ({ ...f, token: v, expiry: "", options_strike: "" }));
    if (v !== "__other__") setManualToken("");
    setNote("");
  }
  function handleTypeChange(v) {
    setForm((f) => ({ ...f, option_type: v, options_strike: "" }));
    fetchLivePrice(form.token, form.expiry, v, null); // clears note if no strike yet; real fetch happens once a strike is picked
  }
  function handleExpiryChange(v) {
    setForm((f) => ({ ...f, expiry: v, options_strike: "" }));
  }
  function handleStrikeChange(v) {
    setForm((f) => ({ ...f, options_strike: v }));
    fetchLivePrice(form.token, form.expiry, form.option_type, v);
  }
  // Auto-fetch once expiry OR type changes and a strike becomes available won't
  // fire automatically here (mirrors the classic dashboard: expiry/type change
  // repopulates strikes but the user picks one, or the effect below fires for
  // the first strike once the list updates — matches odbLiveExpiryChange's
  // "auto-fetch for the first strike" behavior).
  useEffect(() => {
    if (form.token && form.expiry && !isOther && strikes.length && !form.options_strike) {
      const first = String(strikes[0]);
      setForm((f) => ({ ...f, options_strike: first }));
      fetchLivePrice(form.token, form.expiry, form.option_type, first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.expiry, strikes.length]);

  const effectiveToken = isOther ? manualToken : form.token;
  const derived = useMemo(() => computeDerived({ ...form, token: effectiveToken }), [form, effectiveToken]);

  // ── Live BS calc panel (odbLiveCalc port) ──────────────────────────
  const calc = useMemo(() => {
    const K = strikeNumber(form.options_strike);
    const ep = parseFloat(form.opt_entry_price) || 0;
    const qty = parseFloat(form.opt_entry_qty) || 0;
    const S = parseFloat(form.fut_entry_price) || K || 0;
    const ivPct = parseFloat(iv) || 30;
    const sigma = Math.max(0.01, ivPct / 100);
    const optType = (form.option_type || "PUT").toUpperCase();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const expD = form.expiry ? new Date(form.expiry + "T00:00:00") : null;
    const dte = expD && !isNaN(expD) ? Math.max(0, Math.round((expD - today) / 86400000)) : 0;
    const T = dte / 365;
    const Sup = S + (parseFloat(form.upside_distance) || 0);
    const Sdn = S - (parseFloat(form.down_distance) || 0);
    const hasBS = K > 0 && qty !== 0;
    const bsExpiry = (Sp) => { const ivv = optType === "CALL" ? Math.max(Sp - K, 0) : Math.max(K - Sp, 0); return (ivv - ep) * qty; };
    const bsTodayFn = (Sp) => (T > 0 ? (bsPrice(optType.toLowerCase(), Sp, K, T, sigma, 0.05) - ep) * qty : bsExpiry(Sp));
    const bsUp = hasBS ? bsExpiry(Sup) : null;
    const bsDn = hasBS ? bsExpiry(Sdn) : null;
    const bsUpToday = hasBS && Sup > 0 ? bsTodayFn(Sup) : null;
    const bsDnToday = hasBS && Sdn > 0 ? bsTodayFn(Sdn) : null;
    const bsNow = hasBS && S > 0 ? bsTodayFn(S) : null;
    const breakeven = K > 0 ? (optType === "CALL" ? K + ep : K - ep) : null;
    const futUp = Number(derived.upside_fut_pnl) || 0, futDn = Number(derived.downside_fut_pnl) || 0;
    return {
      ivPct, dte,
      bsUpToday, bsDnToday, bsUp, bsDn, bsNow, breakeven, futUp, futDn,
      netUpToday: bsUpToday != null ? bsUpToday + futUp : null,
      netDnToday: bsDnToday != null ? bsDnToday + futDn : null,
      netUpExpiry: bsUp != null ? bsUp + futUp : null,
      netDnExpiry: bsDn != null ? bsDn + futDn : null,
    };
  }, [form, iv, derived]);

  function buildPayload() {
    const f = {};
    for (const k of FIELD_KEYS) f[k] = form[k] ?? "";
    if (f.token === "__other__") f.token = manualToken;
    return f;
  }

  async function handleSave() {
    const payload = buildPayload();
    if (!String(payload.token || "").trim()) { alert("Token is required."); return; }
    setSaving(true); setMsg({ ok: null, text: "Saving…" });
    try {
      const isEdit = editId != null;
      const j = isEdit ? await apiPut(`/api/options-db/trades/${editId}`, payload) : await apiPost("/api/options-db/trades", payload);
      setMsg({ ok: true, text: isEdit ? "✓ Strategy updated." : `✓ Saved as strategy #${j.id}.` });
      if (!isEdit) resetForm();
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setSaving(false);
    }
  }
  async function handleSaveAsNew() {
    const payload = buildPayload();
    setSaving(true);
    try {
      const j = await apiPost("/api/options-db/trades", payload);
      setMsg({ ok: true, text: `✓ Saved as new strategy #${j.id}.` });
      setTimeout(() => router.push(`/add-strategy?id=${j.id}`), 700);
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setSaving(false);
    }
  }

  // ── Execute ─────────────────────────────────────────────────────────
  const [execOpen, setExecOpen] = useState(false);
  const [execPreview, setExecPreview] = useState(null); // { form, inst, editId }
  const [execSummary, setExecSummary] = useState(null); // rendered preview data
  const [execMsg, setExecMsg] = useState(null);
  const [execBusy, setExecBusy] = useState(false);
  const [execResult, setExecResult] = useState(null);

  async function handleExecuteClick() {
    const payload = buildPayload();
    if (!String(payload.token || "").trim()) { alert("Token is required."); return; }
    if (!payload.expiry || !payload.options_strike || !payload.opt_entry_qty || !payload.opt_entry_price) {
      alert("Select token / expiry / strike from the live dropdowns and enter option qty + entry price before executing.");
      return;
    }
    const inst = findInstrument(instruments, payload.token, payload.expiry, payload.option_type, payload.options_strike);
    if (!inst) {
      alert("Could not match a live Deribit instrument for the selected token/expiry/strike/type. Re-pick them via the dropdowns, then try again.");
      return;
    }
    setExecPreview({ form: payload, inst, editId });
    setExecResult(null);
    setExecMsg(null);
    setExecOpen(true);
    setExecSummary(null);
    await renderExecSummary(payload, inst);
  }

  async function renderExecSummary(payload, inst) {
    const usdPrice = Number(payload.opt_entry_price);
    let orderPrice = usdPrice, unit = "USD", usdEquivalent = null, conversionFailed = false;
    if (inst.settlement === "coin") {
      try {
        const t = await apiGet(`/api/deribit/ticker?instrument=${encodeURIComponent(inst.instrument_name)}`);
        const index = Number(t.index_price ?? t.underlying_price) || 0;
        if (!index) throw new Error("no live index price");
        orderPrice = usdPrice / index;
        unit = inst.base_currency;
        usdEquivalent = usdPrice;
      } catch (e) {
        conversionFailed = true;
      }
    }
    const optPrice = roundToTick(orderPrice, inst);
    const rounded = Math.abs(optPrice - orderPrice) > 1e-9;
    const futQty = Number(payload.fut_qty), futPrice = Number(payload.fut_entry_price);
    const hasFut = !!(futQty && futPrice);
    setExecSummary({
      optSide: Number(payload.opt_entry_qty) > 0 ? "BUY" : "SELL",
      optQtyAbs: Math.abs(payload.opt_entry_qty),
      optPrice, unit, usdEquivalent, rounded, conversionFailed,
      instrumentName: inst.instrument_name,
      hasFut,
      futSide: futQty > 0 ? "BUY" : "SELL",
      futQtyAbs: Math.abs(futQty),
      futPrice,
      futUsdContractsNote: inst.settlement === "coin" ? (Math.abs(futQty) * futPrice).toFixed(2) : null,
      token: payload.token,
    });
  }

  function handleCancelExecute() {
    setExecOpen(false);
    setExecPreview(null);
    setExecResult(null);
  }

  async function handleConfirmExecute() {
    if (!execPreview) return;
    const { form: payload, editId: pEditId } = execPreview;
    const isEdit = pEditId != null;
    setExecBusy(true);
    setExecMsg({ ok: null, text: isEdit ? "Saving updates…" : "Saving strategy…" });
    try {
      const url = isEdit ? `/api/options-db/trades/${pEditId}` : "/api/options-db/trades";
      const j = isEdit ? await apiPut(url, payload) : await apiPost(url, payload);
      const id = isEdit ? pEditId : j.id;
      setExecMsg({ ok: null, text: `✓ Strategy #${id} saved. Placing live orders on Deribit…` });
      const ej = await apiPost(`/api/options-db/trades/${id}/execute`, {});
      setExecResult({ id, ...ej });
      if (!isEdit) resetForm();
    } catch (e) {
      setExecMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setExecBusy(false);
    }
  }

  const field = (label, node, extra) => <div className="field"><label>{label}</label>{node}{extra}</div>;
  const numInput = (key, type_ = "number", extraProps = {}) => (
    <input type={type_} step={type_ === "number" ? "any" : undefined} value={form[key] ?? ""} onChange={(e) => setField(key, e.target.value)} {...extraProps} />
  );

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">➕ Add Strategy</div>
        {editId != null && (
          <div style={{ marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>Editing strategy <b>#{editId}</b></div>
        )}
        <div className="page" style={{ alignItems: "start", gridTemplateColumns: "1.7fr 1fr" }}>
          <div className="card">
            <div className="card-header">Strategy Details</div>
            <div className="card-body">
              <div className="section-title">Basic Info</div>
              <div className="row-2">
                {field("Entry Date *", numInput("entry_date", "date"))}
                {field("Token *", (
                  <>
                    <select value={form.token} onChange={(e) => handleTokenChange(e.target.value)}>
                      <option value="">— select —</option>
                      {tokens.map((t) => <option key={t} value={t}>{t}</option>)}
                      {manualToken && !tokens.includes(manualToken) && !isOther && <option value={manualToken}>{manualToken} (saved, not live)</option>}
                      <option value="__other__">✎ Other / Manual…</option>
                    </select>
                    {isOther && <input type="text" placeholder="e.g. HOOD" value={manualToken} onChange={(e) => setManualToken(e.target.value)} style={{ marginTop: 6 }} />}
                  </>
                ))}
              </div>
              <div className="row-2">
                {field("Option Type", (
                  <select value={form.option_type} onChange={(e) => handleTypeChange(e.target.value)}>
                    <option value="PUT">PUT</option>
                    <option value="CALL">CALL</option>
                  </select>
                ))}
                {field("Investment", numInput("investment"))}
              </div>
              <div className="row-2">
                {field("Status", (
                  <select value={form.status} onChange={(e) => setField("status", e.target.value)}>
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                  </select>
                ))}
                {field("End Date", numInput("end_date", "date"))}
              </div>

              <div className="section-title">Option Details <span className="pill pill-blue" style={{ marginLeft: 6 }}>live from Deribit</span></div>
              <div className="row-2">
                {field("Expiry Date", (
                  <select value={form.expiry} onChange={(e) => handleExpiryChange(e.target.value)} disabled={!form.token || isOther}>
                    <option value="">{form.token && !isOther ? "— select —" : "— select token first —"}</option>
                    {expiries.map((d) => (
                      <option key={d} value={d}>{new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" })}</option>
                    ))}
                    {form.expiry && !expiries.includes(form.expiry) && <option value={form.expiry}>{form.expiry} (saved)</option>}
                  </select>
                ))}
                {field("Strike", (
                  <select value={form.options_strike} onChange={(e) => handleStrikeChange(e.target.value)} disabled={!form.expiry}>
                    <option value="">{form.expiry ? "— select —" : "— select expiry first —"}</option>
                    {strikes.map((k) => <option key={k} value={k}>{k}</option>)}
                    {form.options_strike && !strikes.map(String).includes(String(form.options_strike)) && <option value={form.options_strike}>{form.options_strike} (saved)</option>}
                  </select>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "-6px 0 12px" }}>
                <button className="btn-refresh" onClick={() => fetchLivePrice(form.token, form.expiry, form.option_type, form.options_strike)}>↻ Refresh live price / IV</button>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{note}</span>
              </div>
              <div className="row-2">
                {field("Entry Qty", numInput("opt_entry_qty"))}
                {field("Entry Price ", numInput("opt_entry_price"), <span style={{ color: "var(--muted)", textTransform: "none", fontWeight: 600 }}> (live mark)</span>)}
              </div>
              <div className="row-2">
                {field("Exit Price", numInput("opt_exit_price"))}
                {field("Implied Vol σ (%) (live)", <input type="number" step="0.5" placeholder="e.g. 30" value={iv} onChange={(e) => setIv(e.target.value)} />)}
              </div>

              <div className="section-title">Futures Details</div>
              <div className="row-2">
                {field("Fut Qty", numInput("fut_qty"))}
                {field("Fut Entry Price", numInput("fut_entry_price"))}
              </div>
              {field("Fut Exit Price", numInput("fut_exit_price"))}

              <div className="section-title">Distances &amp; Basket</div>
              <div className="row-2">
                {field("Upside Distance", numInput("upside_distance"))}
                {field("Down Distance", numInput("down_distance"))}
              </div>
              <div className="row-2">
                {field("Basket Distance", numInput("basket_distance"))}
                {field("Basket Loss", numInput("basket_loss"))}
              </div>

              <div className="section-title">Close / Booked</div>
              <div className="row-2">
                {field("Net Booked PnL", numInput("net_booked_pnl"))}
                {field("Market Making PL", numInput("market_making_pl"))}
              </div>

              <div className="btn-row" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                <button className="btn btn-start" onClick={handleSave} disabled={saving}>💾 {editId != null ? "Update Strategy" : "Save Strategy"}</button>
                <button className="btn" style={{ background: "#7c3aed", color: "#fff" }} onClick={handleExecuteClick}>⚡ Execute</button>
                {editId != null && <button className="btn" style={{ background: "var(--emerald,#16a34a)", color: "#fff" }} onClick={handleSaveAsNew} disabled={saving}>💾 Save as New</button>}
                <button className="btn btn-stop" onClick={resetForm}>↺ Reset</button>
              </div>
              {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok === false ? "var(--red)" : msg.ok ? "var(--green)" : "var(--muted)" }}>{msg.text}</div>}
            </div>
          </div>

          <div className="card" style={{ position: "sticky", top: 16 }}>
            <div className="card-header">🔒 Auto-Calculated (Live)</div>
            <div className="card-body" style={{ fontSize: 12 }}>
              <CalcGroup title="General / Theta">
                <CalcRow label="Days to Expiry" val={fmtNumOrDash(derived.days_to_expiry, 0)} />
                <CalcRow label="Total Theta" val={fmtCcyOrDash(derived.total_theta_gain_loss)} />
                <CalcRow label="Per Day Theta" val={fmtCcyOrDash(derived.per_day_theta_gain_loss)} signed />
                <CalcRow label="Total Baskets" val={fmtNumOrDash(derived.total_baskets)} />
                <CalcRow label="Total MM Loss" val={fmtCcyOrDash(derived.total_mm_loss)} loss />
              </CalcGroup>
              <CalcGroup title="Limits">
                <CalcRow label="Upper Limit" val={fmtNumOrDash(derived.upper_limit)} />
                <CalcRow label="Lower Limit" val={fmtNumOrDash(derived.lower_limit)} />
              </CalcGroup>
              <CalcGroup title="Return">
                <CalcRow label="APY" val={derived.apy != null ? Number(derived.apy).toFixed(2) + "%" : "—"} signed big />
              </CalcGroup>
              <CalcGroup title={`📊 BS Option PnL (IV ${calc.ivPct}%, ${calc.dte}d)`}>
                <CalcRow label="Upside Opt (Today BS)" val={fmtCcyOrDash(calc.bsUpToday)} signed />
                <CalcRow label="Fut PnL (Upside)" val={fmtCcyOrDash(calc.futUp)} signed />
                <CalcRow label="Downside Opt (Today BS)" val={fmtCcyOrDash(calc.bsDnToday)} signed />
                <CalcRow label="Fut PnL (Downside)" val={fmtCcyOrDash(calc.futDn)} signed />
                <CalcRow label="Upside Opt (Expiry)" val={fmtCcyOrDash(calc.bsUp)} signed />
                <CalcRow label="Downside Opt (Expiry)" val={fmtCcyOrDash(calc.bsDn)} signed />
                <CalcRow label="At Current Price (Today BS)" val={fmtCcyOrDash(calc.bsNow)} signed />
                <CalcRow label="Breakeven Price" val={calc.breakeven != null ? calc.breakeven.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"} />
              </CalcGroup>
              <CalcGroup title="🎯 Net BS Summary">
                <CalcRow label="Net BS Upside (Today)" val={fmtCcyOrDash(calc.netUpToday)} signed big />
                <CalcRow label="Net BS Downside (Today)" val={fmtCcyOrDash(calc.netDnToday)} signed big />
                <CalcRow label="Est Net Upside (Expiry)" val={fmtCcyOrDash(calc.netUpExpiry)} signed big />
                <CalcRow label="Est Net Downside (Expiry)" val={fmtCcyOrDash(calc.netDnExpiry)} signed big />
              </CalcGroup>
            </div>
          </div>
        </div>
      </section>

      {execOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(11,18,32,.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="card" style={{ maxWidth: 520, width: "92%", maxHeight: "85vh", overflowY: "auto" }}>
            <div className="card-header" style={{ color: "#b91c1c" }}>⚠️ Confirm Live Orders — Real Money</div>
            <div className="card-body">
              <div style={{ fontSize: 12.5 }}>
                {!execSummary && !execResult && <span style={{ color: "var(--muted)" }}>Resolving live order price…</span>}
                {execSummary && !execResult && (
                  <>
                    <div style={{ marginBottom: 10 }}>
                      <b>Option leg</b><br />
                      {execSummary.instrumentName} — {execSummary.optSide} {execSummary.optQtyAbs} @ {execSummary.optPrice} {execSummary.unit}
                      {execSummary.rounded && <span style={{ color: "var(--muted)" }}> (rounded to Deribit&apos;s tick size)</span>}
                      {execSummary.usdEquivalent != null && <span style={{ color: "var(--muted)" }}> (≈${execSummary.usdEquivalent} — coin-settled instrument, price is in {execSummary.unit})</span>}
                      {execSummary.conversionFailed && <span style={{ color: "var(--red)" }}> (could not fetch live index to convert — DO NOT confirm, retry instead)</span>}
                      {" "}<span style={{ color: "var(--muted)" }}>(post-only limit)</span>
                    </div>
                    {execSummary.hasFut ? (
                      <div>
                        <b>Futures leg</b><br />
                        {execSummary.token} perpetual — {execSummary.futSide} {execSummary.futQtyAbs} @ {execSummary.futPrice}
                        {execSummary.futUsdContractsNote && <span style={{ color: "var(--muted)" }}> (≈{execSummary.futUsdContractsNote} USD contracts — {execSummary.token}-PERPETUAL is coin-margined, sized in USD not {execSummary.token})</span>}
                        {" "}<span style={{ color: "var(--muted)" }}>(post-only limit — price/qty auto-rounded to Deribit&apos;s tick size if needed)</span>
                      </div>
                    ) : (
                      <div style={{ color: "var(--muted)" }}>No futures leg (fut qty or fut entry price is blank).</div>
                    )}
                  </>
                )}
                {execResult && (
                  <>
                    <div style={{ marginTop: 6, marginBottom: 6 }}>Strategy <b>#{execResult.id}</b> saved.</div>
                    {execResult.option && (
                      execResult.option.ok
                        ? <div style={{ color: "var(--green)" }}>✓ Option: {execResult.option.instrument} {String(execResult.option.side).toUpperCase()} {execResult.option.amount ?? ""} @ {execResult.option.price ?? ""} — order {execResult.option.orderId || "?"} ({execResult.option.state || "placed"})</div>
                        : <div style={{ color: "var(--red)" }}>✗ Option FAILED: {execResult.option.error}</div>
                    )}
                    {execResult.futures && (
                      execResult.futures.ok
                        ? <div style={{ color: "var(--green)" }}>✓ Futures: {execResult.futures.instrument} {String(execResult.futures.side).toUpperCase()} {execResult.futures.amount ?? ""} @ {execResult.futures.price ?? ""} — order {execResult.futures.orderId || "?"} ({execResult.futures.state || "placed"})</div>
                        : <div style={{ color: "var(--red)" }}>✗ Futures FAILED: {execResult.futures.error}</div>
                    )}
                  </>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>
                Post-only maker limit orders. If price has moved and a leg would cross the spread, Deribit rejects that leg (post_only_reject) — it will NOT convert to a taker fill.
              </div>
              <div className="btn-row" style={{ marginTop: 16 }}>
                {!execResult && (
                  <button className="btn" style={{ background: "#b91c1c", color: "#fff" }} onClick={handleConfirmExecute} disabled={execBusy || !execSummary || execSummary.conversionFailed}>
                    ✅ Confirm &amp; Place Live Orders
                  </button>
                )}
                <button className="btn btn-stop" onClick={handleCancelExecute}>{execResult ? "Close" : "Cancel"}</button>
              </div>
              {execMsg && <div style={{ fontSize: 12, marginTop: 10, color: execMsg.ok === false ? "var(--red)" : "var(--muted)" }}>{execMsg.text}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function AddStrategyPage() {
  return (
    <Suspense fallback={<div className="section"><div className="sec-head">➕ Add Strategy</div></div>}>
      <AddStrategyInner />
    </Suspense>
  );
}

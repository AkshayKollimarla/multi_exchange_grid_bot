"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";
import { bsPrice, strikeNumber } from "@/lib/blackScholes";
import { computeDerived, toInputDate } from "@/lib/optionsDerived";
import { tokensFor, expiriesFor, strikesFor, findInstrument } from "@/lib/deribitLiveChain";
import { runOptionEntry, runFuturesEntry } from "@/lib/makerChase";
import { getCollateral } from "@/lib/deribitOrder";

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
  const [accounts, setAccounts] = useState([]);
  const [selectedAcct, setSelectedAcct] = useState("");
  const fetchSeq = useRef(0);

  useEffect(() => {
    apiGet("/api/deribit/instruments").then((list) => setInstruments(Array.isArray(list) ? list : [])).catch(() => {});
    // Drives real per-account execution — every order/collateral/entry-alert
    // call below threads selectedAcct through as account_id. Leaving it
    // unselected falls back to the global .env Deribit key (server.js
    // resolveDeribitCreds), matching every strategy saved before accounts
    // were wired up.
    apiGet("/api/accounts").then((list) => {
      const deribitAccts = (Array.isArray(list) ? list : []).filter((a) => a.exchange === "deribit");
      setAccounts(deribitAccts);
      if (deribitAccts.length) setSelectedAcct(String(deribitAccts[0].id));
    }).catch(() => {});
  }, []);

  const loadTrade = useCallback(async (id) => {
    setMsg(null);
    try {
      const j = await apiGet(`/api/options-db/trades/${id}`);
      const t = j.trade;
      setForm(tradeToForm(t));
      setIv("");
      setEditId(id);
      if (t.account_id) setSelectedAcct(String(t.account_id));
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
      if (markUsd) setForm((f) => ({ ...f, opt_entry_price: markUsd.toFixed(4), fut_entry_price: index ? index.toFixed(4) : f.fut_entry_price }));
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
    f.account_id = selectedAcct || "";
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

  // ── Execute (maker-chase engine) ─────────────────────────────────────
  // No confirmation modal — mirrors trading-dashboard, where Execute fires
  // immediately and progress/results render inline below the buttons.
  const [phase, setPhase] = useState("idle"); // idle | option_pending | futures_pending | done | error
  const [execLogs, setExecLogs] = useState([]);
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState(null);
  const cancelRef = useRef(false);
  const savedTradeIdRef = useRef(null); // the trade this execute run is attached to (new or existing)

  const [acTargetPnl, setAcTargetPnl] = useState("");
  const [acJob, setAcJob] = useState(null);
  const [acError, setAcError] = useState(null);
  const [acStarting, setAcStarting] = useState(false);
  const acTimerRef = useRef(null);
  const autoCloseAfterEntryRef = useRef(false);

  function addExecLog(msg) {
    const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
    setExecLogs((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 50));
  }

  // Saves (or updates) the strategy with whatever fill prices the entry
  // engine reported, so the record reflects what actually executed rather
  // than the pre-fill estimate. Reuses editId if we're already in edit
  // mode; otherwise creates the trade once, on the FIRST successful leg,
  // and every subsequent leg updates that same row.
  async function persistFillPrices(patch) {
    const payload = { ...buildPayload(), ...patch };
    try {
      if (savedTradeIdRef.current == null) {
        const j = editId != null
          ? (await apiPut(`/api/options-db/trades/${editId}`, payload), { id: editId })
          : await apiPost("/api/options-db/trades", payload);
        savedTradeIdRef.current = j.id;
      } else {
        await apiPut(`/api/options-db/trades/${savedTradeIdRef.current}`, payload);
      }
    } catch (e) {
      addExecLog(`Warning: could not save fill price (${e.message})`);
    }
    setForm((f) => ({ ...f, ...patch }));
  }

  // Fire-and-forget — a failed Telegram send should never block or fail
  // the execute flow itself.
  function sendEntryAlert(token, legs, accountId) {
    apiPost("/api/entry-alert", { token, legs, account_id: accountId || undefined }).catch(() => {});
  }

  async function handleExecute() {
    setExecuteError(null); setExecLogs([]);
    const payload = buildPayload();
    if (!String(payload.token || "").trim()) { setExecuteError("Token is required."); return; }
    const optQty = parseFloat(payload.opt_entry_qty) || 0;
    const futQty = parseFloat(payload.fut_qty) || 0;
    if (optQty === 0 && futQty === 0) { setExecuteError("Enter option qty and/or futures qty."); return; }

    let optInst = null;
    if (optQty !== 0) {
      optInst = findInstrument(instruments, payload.token, payload.expiry, payload.option_type, payload.options_strike);
      if (!optInst) { setExecuteError("Select expiry and strike from the live dropdowns to determine the option instrument."); return; }
      if (payload.expiry) {
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const expiryDate = new Date(payload.expiry + "T00:00:00Z");
        if (expiryDate < today) {
          setExecuteError(`${optInst.instrument_name} expired on ${payload.expiry} and can no longer be traded. Pick a current expiry/strike before executing.`);
          return;
        }
      }
    }

    cancelRef.current = false;
    savedTradeIdRef.current = editId;
    setExecuting(true);
    setPhase(optQty !== 0 ? "option_pending" : "futures_pending");
    try {
      // Futures-only path: immediate market order, no chase.
      if (optQty === 0) {
        const perp = await apiGet(`/api/deribit/perpetual?token=${encodeURIComponent(payload.token)}`);
        if (!perp?.instrument_name) throw new Error(`No perpetual futures instrument found for ${payload.token}`);
        const price = await runFuturesEntry({ instrument: perp.instrument_name, qty: futQty, onLog: addExecLog, accountId: payload.account_id });
        await persistFillPrices({ fut_entry_price: price != null ? String(price) : payload.fut_entry_price });
        sendEntryAlert(payload.token, [{ fut_instrument: perp.instrument_name, fut_price: price }], payload.account_id);
        setPhase("done");
        return;
      }

      const markUsd = await runOptionEntry({
        instrument: optInst.instrument_name, qty: optQty, isCoinSettled: optInst.settlement === "coin",
        onLog: addExecLog, isCancelled: () => cancelRef.current, accountId: payload.account_id,
      });
      if (markUsd != null) await persistFillPrices({ opt_entry_price: markUsd.toFixed(4) });

      let futPrice = null, futInstName = null;
      if (futQty !== 0) {
        setPhase("futures_pending");
        const perp = await apiGet(`/api/deribit/perpetual?token=${encodeURIComponent(payload.token)}&prefer=${optInst.settlement}`);
        if (!perp?.instrument_name) throw new Error(`No perpetual futures instrument found for ${payload.token}`);
        futInstName = perp.instrument_name;
        futPrice = await runFuturesEntry({ instrument: perp.instrument_name, qty: futQty, onLog: addExecLog, accountId: payload.account_id });
        await persistFillPrices({ fut_entry_price: futPrice != null ? String(futPrice) : payload.fut_entry_price });
      }
      sendEntryAlert(payload.token, [{ opt_instrument: optInst.instrument_name, opt_price: markUsd, fut_instrument: futInstName, fut_price: futPrice }], payload.account_id);
      setPhase("done");
    } catch (e) {
      setExecuteError(e.message);
      setPhase("error");
    } finally {
      setExecuting(false);
    }
  }

  function cancelExecute() {
    cancelRef.current = true;
    addExecLog("Cancel requested — waiting for the current order to unwind…");
  }

  // The instant entry reports "done", start the auto-close job right
  // against the fresh position — no window for price/PnL to drift before
  // the initial collateral snapshot is taken.
  useEffect(() => {
    if (phase === "done" && autoCloseAfterEntryRef.current) {
      autoCloseAfterEntryRef.current = false;
      startAutoClose();
    }
    if (phase === "error" && autoCloseAfterEntryRef.current) {
      autoCloseAfterEntryRef.current = false; // entry failed — no position to monitor
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function handleExecuteAndAutoClose() {
    if (!(parseFloat(acTargetPnl) > 0)) { setAcError("Enter a Booking PnL Target first."); return; }
    setAcError(null);
    autoCloseAfterEntryRef.current = true;
    await handleExecute();
  }

  // Single primary button: with a Target PnL entered, execute then start
  // auto-close the instant it fills; without one, just execute.
  async function handlePrimaryExecute() {
    if (parseFloat(acTargetPnl) > 0) await handleExecuteAndAutoClose();
    else await handleExecute();
  }

  async function pollAcJob(jobId) {
    try {
      const d = await apiGet(`/api/auto-close?id=${jobId}`);
      if (d.job) {
        setAcJob(d.job);
        if (["completed", "failed", "stopped"].includes(d.job.status)) clearInterval(acTimerRef.current);
      }
    } catch (e) { /* keep polling */ }
  }

  async function startAutoClose() {
    setAcError(null);
    const id = savedTradeIdRef.current;
    const optQty = parseFloat(form.opt_entry_qty) || 0;
    const futQty = parseFloat(form.fut_qty) || 0;
    const token = (form.token || "ETH").toUpperCase();
    const optInst = findInstrument(instruments, form.token, form.expiry, form.option_type, form.options_strike);
    const tPnl = parseFloat(acTargetPnl) || 0;

    if (!optInst || !optQty) { setAcError("No option position configured."); return; }
    if (tPnl <= 0) { setAcError("Enter a target PnL > 0."); return; }

    setAcStarting(true);
    try {
      const bal = await getCollateral(token, selectedAcct);
      if (bal.error) throw new Error(bal.error);
      const perp = futQty !== 0 ? await apiGet(`/api/deribit/perpetual?token=${encodeURIComponent(token)}&prefer=${optInst.settlement}`) : null;
      const j = await apiPost("/api/auto-close", {
        trade_id: id || null,
        token,
        opt_instrument: optInst.instrument_name,
        opt_qty: Math.abs(optQty),
        opt_dir: optQty > 0 ? "sell" : "buy",
        opt_entry_price: form.opt_entry_price || null,
        fut_instrument: perp?.instrument_name || "",
        fut_qty: Math.abs(futQty),
        fut_dir: futQty > 0 ? "sell" : "buy",
        fut_entry_price: form.fut_entry_price || null,
        initial_total_usd: bal.total_usd ?? 0,
        target_pnl: tPnl,
        account_id: selectedAcct || undefined,
      });
      clearInterval(acTimerRef.current);
      pollAcJob(j.id);
      acTimerRef.current = setInterval(() => pollAcJob(j.id), 5000);
    } catch (e) {
      setAcError(e.message);
    } finally {
      setAcStarting(false);
    }
  }

  async function stopAutoClose() {
    if (!acJob?.id) return;
    try {
      await apiDelete(`/api/auto-close?id=${acJob.id}`);
      pollAcJob(acJob.id);
    } catch (e) { setAcError(e.message); }
  }

  // Resume polling if a server auto-close job is already active for this trade.
  useEffect(() => {
    if (editId == null) return;
    apiGet(`/api/auto-close?trade_id=${editId}`).then((d) => {
      const active = (d.jobs || []).find((j) => ["active", "closing_option", "closing_futures"].includes(j.status));
      if (active) {
        clearInterval(acTimerRef.current);
        pollAcJob(active.id);
        acTimerRef.current = setInterval(() => pollAcJob(active.id), 5000);
      }
    }).catch(() => {});
    return () => clearInterval(acTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

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
              {accounts.length > 0 && (
                <div className="field">
                  <label>Account</label>
                  <select value={selectedAcct} onChange={(e) => setSelectedAcct(e.target.value)}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <div className="hint">Manage accounts in the <b>Accounts</b> tab. Execution always uses the single Deribit key configured in .env.</div>
                </div>
              )}
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

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, marginTop: 18 }}>
                <button className="btn" style={{ background: "var(--brand-2)", color: "#fff" }} onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : editId != null ? "Update Strategy" : "Save Strategy"}
                </button>
                {editId != null && (
                  <button className="btn" style={{ background: "var(--green)", color: "#fff" }} onClick={handleSaveAsNew} disabled={saving}>
                    {saving ? "Saving…" : "Save as New Strategy"}
                  </button>
                )}
                <button className="btn" style={{ background: "var(--surface)", color: "var(--ink-2)", border: "1.5px solid var(--border-2)", boxShadow: "none" }} onClick={resetForm}>
                  Reset
                </button>
                <div className="field" style={{ margin: 0, width: 130 }}>
                  <label>Target PnL ($)</label>
                  <input type="number" step="any" min="0" placeholder="e.g. 5" value={acTargetPnl} onChange={(e) => setAcTargetPnl(e.target.value)} />
                </div>
                <button
                  className="btn"
                  style={{ background: "#ea580c", color: "#fff" }}
                  onClick={handlePrimaryExecute}
                  disabled={executing || acStarting}
                >
                  {executing ? "Executing…" : acStarting ? "Starting Monitor…" : `⚡ Execute${parseFloat(acTargetPnl) > 0 ? " + Auto-Close" : ""}`}
                </button>
              </div>
              {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok === false ? "var(--red)" : msg.ok ? "var(--green)" : "var(--muted)" }}>{msg.text}</div>}
              {acError && <div style={{ fontSize: 12, marginTop: 8, color: "var(--red)" }}>{acError}</div>}

              {(phase !== "idle" || executeError) && (
                <div style={{ marginTop: 14, padding: 12, background: "#0b1220", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ color: phase === "error" ? "#f87171" : phase === "done" ? "#4ade80" : "#facc15", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
                      {phase === "option_pending" ? "Placing option order…" : phase === "futures_pending" ? "Placing futures hedge…" : phase === "done" ? "Execution complete" : phase === "error" ? "Execution error" : ""}
                    </span>
                    {(phase === "option_pending" || phase === "futures_pending") && (
                      <button className="btn-refresh" onClick={cancelExecute} style={{ background: "transparent", color: "#f87171", borderColor: "#f87171" }}>Cancel</button>
                    )}
                  </div>
                  {executeError && <div style={{ color: "#f87171", marginBottom: 6 }}>{executeError}</div>}
                  <div style={{ maxHeight: 180, overflowY: "auto", color: "#94a3b8" }}>
                    {execLogs.map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                </div>
              )}
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

        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span>Auto-Close on Profit</span>
            {acJob && (
              <span className={`pill ${
                acJob.status === "completed" ? "pill-green"
                : acJob.status === "failed" ? "pill-red"
                : acJob.status === "stopped" ? "pill-blue"
                : "pill-amber"
              }`}>
                {acJob.status === "active" ? "● Monitoring"
                  : acJob.status === "closing_option" ? "● Closing Option"
                  : acJob.status === "closing_futures" ? "● Closing Futures"
                  : acJob.status === "completed" ? "✓ Done"
                  : acJob.status === "failed" ? "✕ Failed"
                  : acJob.status === "stopped" ? "■ Stopped"
                  : acJob.status}
              </span>
            )}
          </div>
          <div className="card-body">
            {(!acJob || ["completed", "failed", "stopped"].includes(acJob.status)) ? (
              <>
                {acJob && (
                  <div style={{ fontSize: 12, padding: "8px 12px", borderRadius: 8, marginBottom: 12, background: "var(--surface-2)", color: "var(--muted)" }}>
                    Previous job #{acJob.id}: {acJob.status}{acJob.error_msg ? ` — ${acJob.error_msg}` : ""}
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
                  <div className="field" style={{ margin: 0, width: 160 }}>
                    <label>Booking PnL Target ($)</label>
                    <input type="number" step="any" min="0" placeholder="e.g. 500" value={acTargetPnl} onChange={(e) => setAcTargetPnl(e.target.value)} />
                  </div>
                  <div className="field" style={{ margin: 0 }}>
                    <label>Monitors</label>
                    <div style={{ padding: "11px 14px", borderRadius: "var(--r-sm)", background: "var(--surface-2)", border: "1px solid var(--border)", fontSize: 13, color: "var(--muted)" }}>
                      Account Equity ($) — frozen at start, runs on server
                    </div>
                  </div>
                  {parseFloat(acTargetPnl) > 0 && (
                    <div className="field" style={{ margin: 0 }}>
                      <label>Closes When PnL ≥</label>
                      <div style={{ padding: "11px 14px", borderRadius: "var(--r-sm)", background: "var(--green-soft)", border: "1px solid var(--green)", fontSize: 13, fontWeight: 700, color: "var(--green-2)" }}>
                        +${parseFloat(acTargetPnl).toFixed(2)}
                      </div>
                    </div>
                  )}
                  <button className="btn" style={{ background: "var(--green)", color: "#fff" }} onClick={startAutoClose} disabled={acStarting || editId == null || !parseFloat(acTargetPnl)}>
                    {acStarting ? "Starting…" : "▶ Start Auto-Close"}
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 10 }}>
                  Runs on the server — keeps monitoring and closes automatically even if you close this tab.
                  {editId == null && " Save and execute the strategy first, then reload it in edit mode to start a standalone monitor."}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13 }}>
                Job #{acJob.id} — target +${Number(acJob.target_pnl).toFixed(2)}
                {acJob.last_equity_usd != null && <> · equity ${Number(acJob.last_equity_usd).toFixed(2)}</>}
                <div className="btn-row" style={{ marginTop: 10, gridTemplateColumns: "auto auto" }}>
                  <button className="btn-refresh" onClick={stopAutoClose}>Stop</button>
                  <a href={`/monitor?trade_id=${savedTradeIdRef.current || editId || ""}`} className="btn-refresh" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Open Monitor</a>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
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

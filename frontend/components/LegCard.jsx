"use client";

import { useEffect, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtCcy, fmtNum } from "@/lib/format";
import { strikeNumber } from "@/lib/blackScholes";
import { computeDerived } from "@/lib/optionsDerived";
import { tokensFor, expiriesFor, strikesFor, findInstrument } from "@/lib/deribitLiveChain";

export const LEG_TYPES = ["CALL LONG", "CALL SHORT", "PUT LONG", "PUT SHORT"];
const LEG_COLORS = { "CALL LONG": "#10b981", "CALL SHORT": "#f97316", "PUT LONG": "#3b82f6", "PUT SHORT": "#ef4444" };
const LEG_PILL = {
  "CALL LONG": { bg: "#d1fae5", text: "#059669" },
  "CALL SHORT": { bg: "#ffedd5", text: "#c2410c" },
  "PUT LONG": { bg: "#dbeafe", text: "#1d4ed8" },
  "PUT SHORT": { bg: "#fee2e2", text: "#b91c1c" },
};

export function legPillHtml(type) {
  const p = LEG_PILL[type], c = LEG_COLORS[type];
  return { p, c };
}

export function LegPill({ type }) {
  const { p, c } = legPillHtml(type);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: p.bg, color: p.text, fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 800, letterSpacing: ".02em", padding: "4px 12px", borderRadius: 999, whiteSpace: "nowrap" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c, display: "inline-block" }} />{type}
    </span>
  );
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

export function LegCalc({ derived }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", color: "var(--muted)", letterSpacing: ".07em", marginBottom: 6, paddingBottom: 5, borderBottom: "1px solid var(--border)" }}>
        Auto-Calculated
      </div>
      <CalcRow label="Days to Expiry" val={fmtNum(derived.days_to_expiry, 0)} />
      <CalcRow label="Total MM Loss" val={fmtCcy(derived.total_mm_loss)} loss />
      <CalcRow label="Est. Net (Upside)" val={fmtCcy(derived.estimated_upside_net_pnl)} signed />
      <CalcRow label="Est. Net (Down)" val={fmtCcy(derived.estimated_downside_net_pnl)} signed />
      <CalcRow label="APY" val={derived.apy != null ? Number(derived.apy).toFixed(2) + "%" : "—"} signed big />
    </div>
  );
}

// One leg of the Combined Simulator — type selector, live Token/Expiry/Strike
// dropdowns (shares the `instruments` chain fetched once at the page level),
// entry fields, and its own auto-calc panel. Mirrors index.html's
// odbLegCardHtml + odbLegLive* functions.
export default function LegCard({ leg, idx, instruments, onChangeType, onSetField, onRemove, canRemove }) {
  const { type, form } = leg;
  const color = LEG_COLORS[type];
  const [manualToken, setManualToken] = useState(form.token && !tokensFor(instruments).includes(form.token) ? form.token : "");
  const [note, setNote] = useState("");
  const fetchSeq = useRef(0);

  const isOther = form.token === "__other__";
  const tokens = tokensFor(instruments);
  const expiries = form.token && form.token !== "__other__" ? expiriesFor(instruments, form.token) : [];
  const strikes = form.token && form.expiry && form.token !== "__other__" ? strikesFor(instruments, form.token, form.expiry, form.option_type) : [];

  async function fetchLivePrice(token, expiry, strike) {
    if (!token || token === "__other__" || !expiry || !strike) return;
    const inst = findInstrument(instruments, token, expiry, form.option_type, strike);
    if (!inst) { setNote("Not in the live chain (using saved value)."); return; }
    const seq = ++fetchSeq.current;
    onSetField(idx, "opt_entry_price", "");
    onSetField(idx, "iv", "");
    setNote("Fetching live price/IV…");
    try {
      const t = await apiGet(`/api/deribit/ticker?instrument=${encodeURIComponent(inst.instrument_name)}`);
      if (seq !== fetchSeq.current) return; // superseded by a later selection
      const index = Number(t.index_price ?? t.underlying_price) || 0;
      const rawMark = Number(t.mark_price) || 0;
      const markUsd = inst.settlement === "coin" ? rawMark * index : rawMark;
      if (markUsd) onSetField(idx, "opt_entry_price", markUsd.toFixed(4));
      if (t.mark_iv != null) onSetField(idx, "iv", Number(t.mark_iv).toFixed(1));
      if (!form.fut_entry_price && index) onSetField(idx, "fut_entry_price", index.toFixed(4));
      const settleTag = inst.settlement === "coin" ? " (coin-settled)" : "";
      setNote(`${inst.instrument_name}${settleTag} · mark $${markUsd.toFixed(4)} · IV ${Number(t.mark_iv || 0).toFixed(1)}% · index $${index.toFixed(2)}`);
    } catch (e) {
      if (seq === fetchSeq.current) setNote("Live fetch failed: " + e.message);
    }
  }

  function handleTokenChange(v) {
    onSetField(idx, "token", v);
    onSetField(idx, "expiry", "");
    onSetField(idx, "options_strike", "");
    if (v !== "__other__") setManualToken("");
  }
  function handleExpiryChange(v) {
    onSetField(idx, "expiry", v);
    onSetField(idx, "options_strike", "");
  }
  function handleStrikeChange(v) {
    onSetField(idx, "options_strike", v);
    fetchLivePrice(form.token, form.expiry, v);
  }

  const derived = computeDerived(form);
  const field = (label, node) => (
    <div className="field"><label>{label}</label>{node}</div>
  );
  const numInput = (key, type_ = "number") => (
    <input type={type_} step={type_ === "number" ? "any" : undefined} value={form[key] ?? ""} onChange={(e) => onSetField(idx, key, e.target.value)} />
  );

  return (
    <div className="card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b>Leg {idx + 1}</b>
        <select
          value={type}
          onChange={(e) => onChangeType(idx, e.target.value)}
          style={{
            appearance: "none", cursor: "pointer", backgroundColor: LEG_PILL[type].bg, color: LEG_PILL[type].text,
            fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 800, letterSpacing: ".02em",
            border: "none", borderRadius: 999, padding: "5px 30px 5px 14px",
          }}
        >
          {LEG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {type.endsWith("SHORT") && <span style={{ fontFamily: "var(--font-display)", fontSize: 10.5, fontWeight: 700, color: "#c2410c" }}>⚠ negative qty</span>}
        {canRemove && <button className="btn-refresh" style={{ marginLeft: "auto", color: "var(--red)" }} onClick={() => onRemove(idx)}>Remove</button>}
      </div>
      <div className="card-body">
        <div className="row-2">
          {field("Entry Date", numInput("entry_date", "date"))}
          {field("Token *", (
            <>
              <select value={form.token || ""} onChange={(e) => handleTokenChange(e.target.value)}>
                <option value="">— select —</option>
                {tokens.map((t) => <option key={t} value={t}>{t}</option>)}
                {manualToken && !tokens.includes(manualToken) && <option value={manualToken}>{manualToken} (saved, not live)</option>}
                <option value="__other__">✎ Other / Manual…</option>
              </select>
              {isOther && (
                <input type="text" placeholder="e.g. HOOD" value={manualToken} onChange={(e) => { setManualToken(e.target.value); onSetField(idx, "token", e.target.value); }} style={{ marginTop: 6 }} />
              )}
            </>
          ))}
        </div>
        <div className="row-2">
          {field("Investment", numInput("investment"))}
          {field("Expiry Date", (
            <select value={form.expiry || ""} onChange={(e) => handleExpiryChange(e.target.value)} disabled={!form.token || isOther}>
              <option value="">{form.token && !isOther ? "— select —" : "— select token first —"}</option>
              {expiries.map((d) => (
                <option key={d} value={d}>{new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit" })}</option>
              ))}
            </select>
          ))}
        </div>
        <div className="row-2">
          {field("Strike", (
            <select value={form.options_strike || ""} onChange={(e) => handleStrikeChange(e.target.value)} disabled={!form.expiry}>
              <option value="">{form.expiry ? "— select —" : "— select expiry first —"}</option>
              {strikes.map((k) => <option key={k} value={k}>{k}</option>)}
              {form.options_strike && !strikes.map(String).includes(String(form.options_strike)) && (
                <option value={form.options_strike}>{form.options_strike} (saved)</option>
              )}
            </select>
          ))}
          {field(`Entry Qty${type.endsWith("SHORT") ? " (neg)" : ""}`, numInput("opt_entry_qty"))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "-6px 0 10px" }}>
          <button className="btn-refresh" style={{ fontSize: 11, padding: "5px 10px" }} onClick={() => fetchLivePrice(form.token, form.expiry, form.options_strike)}>↻ Refresh live</button>
          <span style={{ fontSize: 10.5, color: "var(--muted)" }}>{note}</span>
        </div>
        <div className="row-2">{field("Entry Price (live mark)", numInput("opt_entry_price"))}{field("Exit Price", numInput("opt_exit_price"))}</div>
        <div className="row-2">{field("Fut Qty", numInput("fut_qty"))}{field("Fut Entry Price", numInput("fut_entry_price"))}</div>
        <div className="row-2">{field("Fut Exit Price", numInput("fut_exit_price"))}{field("IV (%) for BS (live)", numInput("iv"))}</div>
        <div className="row-2">{field("Upside Distance", numInput("upside_distance"))}{field("Down Distance", numInput("down_distance"))}</div>
        <div className="row-2">{field("Basket Distance", numInput("basket_distance"))}{field("Basket Loss", numInput("basket_loss"))}</div>
        <div className="row-2">{field("Net Booked PnL", numInput("net_booked_pnl"))}{field("Market Making PL", numInput("market_making_pl"))}</div>
        <div className="row-2">
          {field("Status", (
            <select value={form.status || "open"} onChange={(e) => onSetField(idx, "status", e.target.value)}>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          ))}
          {field("End Date", numInput("end_date", "date"))}
        </div>
        <div style={{ background: "var(--surface-2)", borderRadius: "var(--r-md)", padding: "12px 14px", marginTop: 4 }}>
          <LegCalc derived={derived} />
        </div>
      </div>
    </div>
  );
}

export { computeDerived, strikeNumber };

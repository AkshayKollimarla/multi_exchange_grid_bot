"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { fmtCcy } from "@/lib/format";
import { bsPrice, strikeNumber } from "@/lib/blackScholes";
import { computeDerived, toInputDate } from "@/lib/optionsDerived";
import LegCard, { LegPill, LEG_TYPES } from "@/components/LegCard";

function emptyLegForm() {
  return {
    entry_date: "", token: "", investment: "", options_strike: "", expiry: "",
    opt_entry_qty: "", opt_entry_price: "", opt_exit_price: "", iv: "",
    fut_qty: "", fut_entry_price: "", fut_exit_price: "",
    upside_distance: "", down_distance: "", basket_distance: "", basket_loss: "",
    net_booked_pnl: "", market_making_pl: "", end_date: "", status: "open", option_type: "CALL",
  };
}
function makeLeg(type) {
  return { type, form: { ...emptyLegForm(), option_type: type.startsWith("CALL") ? "CALL" : "PUT" } };
}
function detectLegType(t) {
  const isCall = (t.option_type || "").toUpperCase() === "CALL", isShort = Number(t.opt_entry_qty) < 0;
  if (isCall && !isShort) return "CALL LONG";
  if (isCall && isShort) return "CALL SHORT";
  if (!isCall && !isShort) return "PUT LONG";
  return "PUT SHORT";
}
function tradeToLegForm(t) {
  return {
    entry_date: toInputDate(t.entry_date), token: t.token || "", investment: t.investment ?? "",
    options_strike: t.options_strike || "", expiry: toInputDate(t.expiry),
    opt_entry_qty: t.opt_entry_qty ?? "", opt_entry_price: t.opt_entry_price ?? "", opt_exit_price: t.opt_exit_price ?? "",
    iv: "", fut_qty: t.fut_qty ?? "", fut_entry_price: t.fut_entry_price ?? "", fut_exit_price: t.fut_exit_price ?? "",
    upside_distance: t.upside_distance ?? "", down_distance: t.down_distance ?? "",
    basket_distance: t.basket_distance ?? "", basket_loss: t.basket_loss ?? "",
    net_booked_pnl: t.net_booked_pnl ?? "", market_making_pl: t.market_making_pl ?? "",
    end_date: toInputDate(t.end_date), status: t.status || "open", option_type: t.option_type || "CALL",
  };
}

function legBsTodayPnl(form, optType, Starget) {
  const K = strikeNumber(form.options_strike), ep = parseFloat(form.opt_entry_price) || 0, qty = parseFloat(form.opt_entry_qty) || 0;
  if (!K || !qty) return 0;
  const sigma = Math.max(0.01, (parseFloat(form.iv) || 30) / 100);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expD = form.expiry ? new Date(form.expiry + "T00:00:00") : null;
  const dte = expD && !isNaN(expD) ? Math.max(0, Math.round((expD - today) / 86400000)) : 0;
  const T = dte / 365;
  if (T > 0) return (bsPrice(optType.toLowerCase(), Starget, K, T, sigma, 0.05) - ep) * qty;
  const intrinsic = optType === "CALL" ? Math.max(Starget - K, 0) : Math.max(K - Starget, 0);
  return (intrinsic - ep) * qty;
}

function ScenarioBlock({ title, scenario, totals, deriveds, bsToday, legs }) {
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 10, padding: 14 }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 13, fontWeight: 800, color: "var(--ink)", marginBottom: 8 }}>{title}</div>
      {legs.map((l, i) => {
        const v = scenario === "up" ? Number(deriveds[i].upside_opt_pnl) : Number(deriveds[i].down_opt_pnl);
        return <Row key={i} label={`Opt PnL — Leg ${i + 1} (${l.type})`} val={fmtCcy(v)} signed />;
      })}
      <Row label="Fut PnL (combined)" val={fmtCcy(totals.fut)} signed />
      <Row label="Total MM Loss" val={fmtCcy(totals.mm)} signed />
      <Row label={`Est. Net ${scenario === "up" ? "Upside" : "Downside"}`} val={fmtCcy(totals.net)} signed big />
      <Row label={`Today BS ${scenario === "up" ? "Upside" : "Downside"}`} val={fmtCcy(bsToday)} signed big />
    </div>
  );
}
function Row({ label, val, big, signed }) {
  const n = Number(String(val).replace(/[^0-9.-]/g, ""));
  const isNum = !isNaN(n) && val !== "—";
  const color = signed && isNum ? (n >= 0 ? "var(--green-2)" : "var(--red-2)") : "var(--ink)";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: big ? "6px 0" : "4px 0", borderBottom: "1px dashed var(--border)" }}>
      <span style={{ fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: ".04em", fontSize: big ? 11 : 10.5, fontWeight: big ? 700 : 600, color: big ? "var(--ink-2)" : "var(--muted)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: big ? 14 : 12.5, fontWeight: 700, color, whiteSpace: "nowrap" }}>{val}</span>
    </div>
  );
}

function CombinedSimulatorInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const groupParam = searchParams.get("group");

  const [legs, setLegs] = useState(() => [makeLeg("CALL LONG"), makeLeg("PUT LONG")]);
  const [editIds, setEditIds] = useState([]);
  const [editGroupId, setEditGroupId] = useState(null);
  const [instruments, setInstruments] = useState([]);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet("/api/deribit/instruments").then((list) => setInstruments(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  const loadGroup = useCallback(async (groupId) => {
    setMsg(null);
    try {
      const j = await apiGet(`/api/options-db/trades?group_id=${encodeURIComponent(groupId)}`);
      const members = j.trades || [];
      if (!members.length) throw new Error("No legs found for this group.");
      setLegs(members.map((t) => ({ type: detectLegType(t), form: tradeToLegForm(t) })));
      setEditIds(members.map((m) => m.id));
      setEditGroupId(groupId);
    } catch (e) {
      setMsg({ ok: false, text: "Load failed: " + e.message });
    }
  }, []);

  useEffect(() => {
    if (groupParam) loadGroup(groupParam);
  }, [groupParam, loadGroup]);

  function resetNew() {
    setLegs([makeLeg("CALL LONG"), makeLeg("PUT LONG")]);
    setEditIds([]);
    setEditGroupId(null);
    setMsg(null);
    router.replace("/combined-simulator");
  }
  function addLeg() {
    setLegs((ls) => [...ls, makeLeg("CALL LONG")]);
    setEditIds((ids) => [...ids, null]);
  }
  function removeLeg(idx) {
    if (legs.length <= 2) return;
    setLegs((ls) => ls.filter((_, i) => i !== idx));
    setEditIds((ids) => ids.filter((_, i) => i !== idx));
  }
  function changeLegType(idx, type) {
    setLegs((ls) => ls.map((l, i) => {
      if (i !== idx) return l;
      const isShort = type.endsWith("SHORT");
      const raw = l.form.opt_entry_qty;
      const opt_entry_qty = raw !== "" && !isNaN(Number(raw)) ? String(isShort ? -Math.abs(Number(raw)) : Math.abs(Number(raw))) : raw;
      return { type, form: { ...l.form, option_type: type.startsWith("CALL") ? "CALL" : "PUT", opt_entry_qty } };
    }));
  }
  function setLegField(idx, key, value) {
    setLegs((ls) => ls.map((l, i) => (i === idx ? { ...l, form: { ...l.form, [key]: value } } : l)));
  }

  const deriveds = useMemo(() => legs.map((l) => computeDerived(l.form)), [legs]);
  const n = (v) => Number(v) || 0;

  const totalInvestment = legs.reduce((s, l) => s + n(l.form.investment), 0);
  const bookedPnl = legs.reduce((s, l) => s + n(l.form.net_booked_pnl), 0);
  const mmPl = legs.reduce((s, l) => s + n(l.form.market_making_pl), 0);
  const combinedApy = totalInvestment ? (bookedPnl / totalInvestment) * 365 * 100 : null;

  const upside = {
    opt: deriveds.reduce((s, d) => s + n(d.upside_opt_pnl), 0), fut: deriveds.reduce((s, d) => s + n(d.upside_fut_pnl), 0),
    mm: deriveds.reduce((s, d) => s + n(d.total_mm_loss), 0), net: deriveds.reduce((s, d) => s + n(d.estimated_upside_net_pnl), 0),
  };
  const downside = {
    opt: deriveds.reduce((s, d) => s + n(d.down_opt_pnl), 0), fut: deriveds.reduce((s, d) => s + n(d.downside_fut_pnl), 0),
    mm: deriveds.reduce((s, d) => s + n(d.total_mm_loss), 0), net: deriveds.reduce((s, d) => s + n(d.estimated_downside_net_pnl), 0),
  };
  const bsUpsideCombined = legs.reduce((s, l) => {
    const S = parseFloat(l.form.fut_entry_price) || 0, opt = (l.form.option_type || "PUT").toUpperCase();
    return s + legBsTodayPnl(l.form, opt, S + (parseFloat(l.form.upside_distance) || 0));
  }, 0);
  const bsDownsideCombined = legs.reduce((s, l) => {
    const S = parseFloat(l.form.fut_entry_price) || 0, opt = (l.form.option_type || "PUT").toUpperCase();
    return s + legBsTodayPnl(l.form, opt, S - (parseFloat(l.form.down_distance) || 0));
  }, 0);

  const rowsDef = [
    { label: "Upside Opt PnL", key: "upside_opt_pnl", total: upside.opt },
    { label: "Down Opt PnL", key: "down_opt_pnl", total: downside.opt },
    { label: "Upside Fut PnL", key: "upside_fut_pnl", total: upside.fut },
    { label: "Down Fut PnL", key: "downside_fut_pnl", total: downside.fut },
    { label: "MM Loss", key: "total_mm_loss", total: upside.mm },
    { label: "Est. Net (Up)", key: "estimated_upside_net_pnl", total: upside.net, bold: true },
    { label: "Est. Net (Down)", key: "estimated_downside_net_pnl", total: downside.net, bold: true },
  ];

  async function saveAll() {
    if (editGroupId) return updateGroup();
    setSaving(true); setMsg({ ok: null, text: "Saving…" });
    try {
      const groupId = `combined_${Date.now()}`;
      for (const leg of legs) {
        await apiPost("/api/options-db/trades", { ...leg.form, group_id: groupId });
      }
      setMsg({ ok: true, text: `✓ Saved ${legs.length} legs.` });
      setTimeout(() => router.push("/options-dashboard"), 1200);
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setSaving(false);
    }
  }
  async function updateGroup() {
    setSaving(true); setMsg({ ok: null, text: "Saving…" });
    try {
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i], id = editIds[i], body = { ...leg.form, group_id: editGroupId };
        if (id) await apiPut(`/api/options-db/trades/${id}`, body);
        else await apiPost("/api/options-db/trades", body);
      }
      setMsg({ ok: true, text: "✓ All strategies updated." });
      setTimeout(() => router.push("/options-dashboard"), 1200);
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setSaving(false);
    }
  }
  async function saveAsNew() {
    setSaving(true); setMsg({ ok: null, text: "Saving…" });
    try {
      const newGroupId = `combined_${Date.now()}`;
      for (const leg of legs) {
        await apiPost("/api/options-db/trades", { ...leg.form, group_id: newGroupId });
      }
      setMsg({ ok: true, text: "✓ Saved as new combined group." });
      setTimeout(() => router.push("/options-dashboard"), 1200);
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>🧮 Combined Simulator</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {legs.map((l, i) => <LegPill key={i} type={l.type} />)}
          </div>
        </div>

        {editGroupId && (
          <div style={{ marginBottom: 10, fontSize: 12, color: "var(--muted)" }}>
            Editing combined group <b>{editGroupId}</b> ·{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); resetNew(); }}>start a new one instead</a>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 18 }}>
          {legs.map((leg, idx) => (
            <LegCard
              key={idx} leg={leg} idx={idx} instruments={instruments}
              onChangeType={changeLegType} onSetField={setLegField}
              onRemove={removeLeg} canRemove={legs.length > 2}
            />
          ))}
        </div>

        <div className="btn-row" style={{ margin: "14px 0", gridTemplateColumns: "auto auto" }}>
          <button className="btn-refresh" onClick={addLeg}>＋ Add Leg</button>
          <button className="btn-refresh" onClick={resetNew}>🆕 New Combined Strategy</button>
        </div>

        <div className="card">
          <div className="card-header">Combined Net PnL</div>
          <div className="card-body">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 14 }}>
              <div className="pnl-card pnl-neutral"><div className="stat-label">Total Investment</div><div className="stat-value blue">{fmtCcy(totalInvestment)}</div></div>
              <div className="pnl-card pnl-neutral"><div className="stat-label">Booked PnL</div><div className="stat-value" style={{ color: bookedPnl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(bookedPnl)}</div></div>
              <div className="pnl-card pnl-neutral"><div className="stat-label">MM PL</div><div className="stat-value" style={{ color: mmPl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(mmPl)}</div></div>
              <div className="pnl-card pnl-neutral"><div className="stat-label">Combined APY</div><div className="stat-value" style={{ color: "#9333ea" }}>{combinedApy != null ? combinedApy.toFixed(2) + "%" : "—"}</div></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <ScenarioBlock title="📈 Upside Scenario" scenario="up" totals={upside} deriveds={deriveds} bsToday={bsUpsideCombined} legs={legs} />
              <ScenarioBlock title="📉 Downside Scenario" scenario="down" totals={downside} deriveds={deriveds} bsToday={bsDownsideCombined} legs={legs} />
            </div>
            <div className="section-title" style={{ marginTop: 14 }}>Side-by-Side Breakdown</div>
            <table className="ord-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  {legs.map((l, i) => <th key={i} style={{ color: { "CALL LONG": "#10b981", "CALL SHORT": "#f97316", "PUT LONG": "#3b82f6", "PUT SHORT": "#ef4444" }[l.type] }}>Leg {i + 1} · {l.type}</th>)}
                  <th>Combined</th>
                </tr>
              </thead>
              <tbody>
                {rowsDef.map((r) => (
                  <tr key={r.key}>
                    <td style={r.bold ? { fontWeight: 700 } : { color: "var(--muted)" }}>{r.label}</td>
                    {deriveds.map((d, i) => <td key={i} style={{ color: n(d[r.key]) >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(d[r.key])}</td>)}
                    <td style={{ fontWeight: 800, color: r.total >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <button className="btn btn-start" onClick={saveAll} disabled={saving}>
                {editGroupId ? "💾 Update Strategy" : "💾 Save All Legs"}
              </button>
              {editGroupId && (
                <button className="btn" style={{ background: "var(--green)", color: "#fff" }} onClick={saveAsNew} disabled={saving}>
                  💾 Add as New Strategy
                </button>
              )}
            </div>
            {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok === false ? "var(--red)" : msg.ok ? "var(--green)" : "var(--muted)" }}>{msg.text}</div>}
          </div>
        </div>
      </section>
    </>
  );
}

export default function CombinedSimulatorPage() {
  return (
    <Suspense fallback={<div className="section"><div className="sec-head">🧮 Combined Simulator</div></div>}>
      <CombinedSimulatorInner />
    </Suspense>
  );
}

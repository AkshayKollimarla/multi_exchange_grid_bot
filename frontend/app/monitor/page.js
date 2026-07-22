"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiGet, apiDelete, apiPatch } from "@/lib/api";

function fmtCcy(v) {
  if (v == null || isNaN(v)) return "—";
  const n = Number(v);
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
}

function StatusPill({ status }) {
  const colors = {
    active: { bg: "#dcfce7", fg: "#16a34a" },
    closing_option: { bg: "#fef3c7", fg: "#b45309" },
    closing_futures: { bg: "#fef3c7", fg: "#b45309" },
    closing: { bg: "#fef3c7", fg: "#b45309" },
    completed: { bg: "#d1fae5", fg: "#059669" },
    failed: { bg: "#fee2e2", fg: "#b91c1c" },
    stopped: { bg: "#f1f5f9", fg: "#475569" },
  };
  const c = colors[status] || colors.stopped;
  return <span style={{ background: c.bg, color: c.fg, padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap" }}>{status}</span>;
}

// Reusable header: back link + big "Monitor" title + strategy subtitle on
// the left, status pill top-right — shared by the single-leg and combo views.
function MonitorHeader({ subtitle, status }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
      <div>
        <a href="/monitor" style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500 }}>← Strategies</a>
        <div style={{ fontSize: 28, fontWeight: 700, color: "var(--ink)", fontFamily: "var(--font-display)", marginTop: 6, letterSpacing: "-0.02em" }}>Monitor</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>{subtitle}</div>
      </div>
      <StatusPill status={status} />
    </div>
  );
}

// Reusable compact KPI card — used for Initial Collateral / Current Equity /
// PnL-Target / Final Equity and the Live Equity / Live Mark-to-Market row.
function KpiCard({ label, value, color }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 18, boxShadow: "var(--shadow-sm)" }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--muted-3)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || "var(--ink)", fontFamily: "var(--font-display)", letterSpacing: "-0.01em" }}>{value}</div>
    </div>
  );
}

// PnL/Target KPI card with an inline editor — changes only target_pnl (and
// the target_total_usd the server derives from it); initial_total_usd, the
// frozen-at-start collateral baseline, is never touched by this control.
function TargetPnlCard({ pnl, targetPnl, onSave, disabled }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(targetPnl ?? ""));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { if (!editing) setVal(targetPnl != null ? Number(targetPnl).toFixed(1) : ""); }, [targetPnl, editing]);

  async function save() {
    const parsed = parseFloat(val);
    if (!(parsed > 0)) { setErr("Target must be > 0"); return; }
    const n = Math.round(parsed * 10) / 10;
    setSaving(true); setErr(null);
    try { await onSave(n); setEditing(false); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: 18, boxShadow: "var(--shadow-sm)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: "var(--muted-3)" }}>PnL / Target</div>
        {!disabled && !editing && (
          <button onClick={() => setEditing(true)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "var(--brand)", fontWeight: 600, padding: 0 }}>✎ Edit</button>
        )}
      </div>
      {editing ? (
        <div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>$</span>
            <input
              type="text" inputMode="decimal" value={val}
              onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d*$/.test(v)) setVal(v); }}
              autoFocus
              style={{ width: 70, fontSize: 16, fontWeight: 700, border: "1px solid var(--border-2)", borderRadius: 6, padding: "4px 6px" }}
            />
            <button onClick={save} disabled={saving} className="btn" style={{ height: 28, padding: "0 10px", fontSize: 12, background: "var(--green)", color: "#fff", boxShadow: "none" }}>
              {saving ? "…" : "Save"}
            </button>
            <button onClick={() => { setEditing(false); setErr(null); }} disabled={saving} style={{ height: 28, padding: "0 10px", fontSize: 12, background: "transparent", border: "1px solid var(--border-2)", borderRadius: 6, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
          {err && <div style={{ color: "var(--red)", fontSize: 11, marginTop: 4 }}>{err}</div>}
        </div>
      ) : (
        <div style={{ fontSize: 26, fontWeight: 700, color: pnl >= 0 ? "#16a34a" : "#dc2626", fontFamily: "var(--font-display)", letterSpacing: "-0.01em" }}>
          {fmtCcy(pnl)} / +{fmtCcy(targetPnl)}
        </div>
      )}
    </div>
  );
}

function LogPanel({ logs }) {
  return (
    <div style={{ marginTop: 20, padding: 14, background: "#111827", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 13, color: "#22c55e", maxHeight: 320, overflowY: "auto", lineHeight: 1.7 }}>
      {(!logs || !logs.length) && <div style={{ color: "#6b7280" }}>No log entries yet.</div>}
      {[...(logs || [])].reverse().map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

// ── Live preview (independent of the 10s job-status poll) ──────────────
// The job row only updates last_equity_usd on its own worker tick (every
// 5s server-side, but the client only re-fetches it every 10s here) —
// this gives a live between-ticks read of collateral + mark-to-market
// option/futures PnL, purely for display. Never touches orders/positions.
const LIVE_POLL_MS = 30000;

// Perpetuals (inverse coin-margined AND linear USDC-margined alike) always
// quote mark_price in USD already — only coin-settled OPTIONS report
// mark_price in the underlying coin and need the underlying-price multiply.
function isPerpetual(instrument) {
  return /-PERPETUAL$/i.test(instrument || "");
}
function isCoinSettledOption(instrument) {
  return !!instrument && !isPerpetual(instrument) && !/_USDC|_USDT/i.test(instrument);
}

// Fetches both the live mark and the account's REAL average_price for this
// instrument (from Deribit's own position, not our recorded entry price) —
// the two use the same coin/USD convention so both get the same conversion.
// The real position is the source of truth: our recorded entry_price can
// drift from it (a re-quote landing at a different fill than logged, or the
// same instrument carrying other activity on the account), and Deribit's
// own average_price is exactly what its own position/PnL screens show.
async function fetchInstrumentLive(instrument, accountId) {
  if (!instrument) return { markUsd: null, avgPriceUsd: null };
  const acctQs = accountId ? `&account_id=${encodeURIComponent(accountId)}` : "";
  try {
    const [t, pos] = await Promise.all([
      apiGet(`/api/deribit/ticker?instrument=${encodeURIComponent(instrument)}`),
      apiGet(`/api/deribit/position?instrument=${encodeURIComponent(instrument)}${acctQs}`).catch(() => null),
    ]);
    const perp = isPerpetual(instrument);
    const coinOpt = isCoinSettledOption(instrument);
    const underlying = t.underlying_price ?? t.index_price ?? 1;
    const convert = (raw) => (raw == null ? null : perp ? raw : coinOpt ? raw * underlying : raw);
    const hasOpenPosition = pos && pos.average_price != null && Math.abs(parseFloat(pos.size ?? 0)) > 0;
    return {
      markUsd: convert(t.mark_price ?? 0),
      avgPriceUsd: hasOpenPosition ? convert(pos.average_price) : null,
    };
  } catch (e) { return { markUsd: null, avgPriceUsd: null }; }
}

// dir is the CLOSING direction the job stores (opt_dir/fut_dir): "sell"
// closes a long (original qty was positive), "buy" closes a short
// (original qty was negative) — same convention as server.js's workers.
function signedQty(qty, dir) {
  const mag = Math.abs(Number(qty) || 0);
  return dir === "sell" ? mag : -mag;
}

// avgPrices holds the exchange's real average_price per instrument (falls
// back to the leg's own recorded entry price when the position lookup
// failed or came back flat, e.g. a leg that's already closed).
function legLivePnl(leg, tickers, avgPrices) {
  let pnl = 0;
  if (leg.opt_instrument && Number(leg.opt_qty)) {
    const mark = tickers[leg.opt_instrument];
    const entry = avgPrices?.[leg.opt_instrument] ?? Number(leg.opt_entry_price || 0);
    if (mark != null) pnl += (mark - entry) * signedQty(leg.opt_qty, leg.opt_dir);
  }
  if (leg.fut_instrument && Number(leg.fut_qty)) {
    const mark = tickers[leg.fut_instrument];
    const entry = avgPrices?.[leg.fut_instrument] ?? Number(leg.fut_entry_price || 0);
    if (mark != null) pnl += (mark - entry) * signedQty(leg.fut_qty, leg.fut_dir);
  }
  return pnl;
}

// items: either [job] (single-leg) or the combo's legs array — both shapes
// carry opt_instrument/opt_qty/opt_dir/opt_entry_price (+ fut_* equivalents).
function useLivePreview(job, items, isTerminal) {
  const [preview, setPreview] = useState(null);
  const timerRef = useRef(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const refresh = useCallback(async () => {
    if (!job || !job.token) return;
    try {
      const curItems = itemsRef.current;
      const instruments = [...new Set(curItems.flatMap((l) => [l.opt_instrument, l.fut_instrument].filter(Boolean)))];
      const [bal, ...liveVals] = await Promise.all([
        apiGet(`/api/deribit/collateral?token=${encodeURIComponent(job.token)}${job.account_id ? `&account_id=${job.account_id}` : ""}`),
        ...instruments.map((inst) => fetchInstrumentLive(inst, job.account_id)),
      ]);
      const tickers = {}, avgPrices = {};
      instruments.forEach((inst, i) => { tickers[inst] = liveVals[i].markUsd; avgPrices[inst] = liveVals[i].avgPriceUsd; });
      const bsPnl = curItems.reduce((s, l) => s + legLivePnl(l, tickers, avgPrices), 0);
      const balOk = bal && !bal.error;
      setPreview({
        liveEquity: balOk ? bal.total_usd : null,
        coinSymbol: balOk ? bal.coin_symbol : null,
        coinEquityUsd: balOk ? bal.coin_equity_usd : null,
        usdcEquity: balOk ? bal.usdc_equity : null,
        bsPnl,
      });
    } catch (e) { /* keep last preview on a transient fetch error */ }
  }, [job?.id, job?.token, job?.account_id]);

  useEffect(() => {
    if (!job || isTerminal) return;
    refresh();
    timerRef.current = setInterval(refresh, LIVE_POLL_MS);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, isTerminal, refresh]);

  return preview;
}

function LivePreviewRow({ preview }) {
  if (!preview) return null;
  // Coin-specific equity is only worth its own card for coin-margined
  // tokens (ETH/BTC) — deribitCollateral() falls back coin_symbol to
  // "USDC" for linear-only tokens (SOL_USDC, ...), which would just
  // duplicate the USDC Equity card below.
  const showCoinCard = preview.coinSymbol && preview.coinSymbol !== "USDC";
  const cols = showCoinCard ? 4 : 2;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols},1fr)`, gap: 16, marginBottom: 20 }}>
      <KpiCard label="Live Equity" value={preview.liveEquity != null ? fmtCcy(preview.liveEquity) : "—"} />
      {showCoinCard && (
        <KpiCard label={`${preview.coinSymbol} Equity ($)`} value={preview.coinEquityUsd != null ? fmtCcy(preview.coinEquityUsd) : "—"} color="var(--brand)" />
      )}
      {showCoinCard && (
        <KpiCard label="USDC Equity" value={preview.usdcEquity != null ? fmtCcy(preview.usdcEquity) : "—"} color="var(--brand)" />
      )}
      <KpiCard label="Live Mark-to-Market PnL" value={fmtCcy(preview.bsPnl)} color={preview.bsPnl >= 0 ? "#16a34a" : "#dc2626"} />
    </div>
  );
}

function SingleLegMonitor({ tradeId }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [stopping, setStopping] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const list = await apiGet(`/api/auto-close?trade_id=${encodeURIComponent(tradeId)}`);
      const latest = (list.jobs || [])[0];
      if (!latest) { setJob(null); setError("No auto-close job found for this strategy yet."); return; }
      const detail = await apiGet(`/api/auto-close?id=${latest.id}`);
      setJob(detail.job);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [tradeId]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 10000);
    return () => clearInterval(timerRef.current);
  }, [load]);

  async function stop() {
    if (!job) return;
    setStopping(true);
    try { await apiDelete(`/api/auto-close?id=${job.id}`); await load(); }
    catch (e) { setError(e.message); }
    finally { setStopping(false); }
  }

  const isTerminal = job ? ["completed", "failed", "stopped"].includes(job.status) : true;
  const preview = useLivePreview(job, job ? [job] : [], isTerminal);

  if (error && !job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>{error}</div></div>;
  if (!job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>;

  const pnl = job.last_equity_usd != null ? Number(job.last_equity_usd) - Number(job.initial_total_usd) : null;

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, boxShadow: "0 2px 8px rgba(0,0,0,.04)" }}>
      <MonitorHeader subtitle={`${job.opt_instrument}${job.fut_instrument ? ` + ${job.fut_instrument}` : ""}`} status={job.status} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 }}>
        <KpiCard label="Initial Collateral" value={fmtCcy(job.initial_total_usd)} color="var(--brand)" />
        <KpiCard label="Current Equity" value={fmtCcy(job.last_equity_usd)} />
        <TargetPnlCard
          pnl={pnl} targetPnl={job.target_pnl} disabled={isTerminal}
          onSave={async (n) => { await apiPatch(`/api/auto-close?id=${job.id}`, { target_pnl: n }); await load(); }}
        />
        <KpiCard label="Final Equity" value={job.final_equity_usd != null ? fmtCcy(job.final_equity_usd) : "—"} />
      </div>
      {!isTerminal && <LivePreviewRow preview={preview} />}
      <table className="ord-table">
        <thead><tr><th>Leg</th><th>Entry</th><th>Close</th></tr></thead>
        <tbody>
          <tr><td>Option — {job.opt_instrument}</td><td>{job.opt_entry_price != null ? fmtCcy(job.opt_entry_price) : "—"}</td><td>{job.opt_close_price != null ? fmtCcy(job.opt_close_price) : "—"}</td></tr>
          {job.fut_instrument && <tr><td>Futures — {job.fut_instrument}</td><td>{job.fut_entry_price != null ? fmtCcy(job.fut_entry_price) : "—"}</td><td>{job.fut_close_price != null ? fmtCcy(job.fut_close_price) : "—"}</td></tr>}
        </tbody>
      </table>
      {!isTerminal && (
        <button className="btn btn-stop" onClick={stop} disabled={stopping} style={{ width: "100%", height: 44, marginTop: 20 }}>
          {stopping ? "Stopping…" : "Stop Monitor"}
        </button>
      )}
      {job.error_msg && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{job.error_msg}</div>}
      <LogPanel logs={job.logs} />
    </div>
  );
}

function ComboMonitor({ groupId }) {
  const [job, setJob] = useState(null);
  const [legs, setLegs] = useState([]);
  const [error, setError] = useState(null);
  const [stopping, setStopping] = useState(false);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const list = await apiGet(`/api/auto-close-combo?group_id=${encodeURIComponent(groupId)}`);
      const latest = (list.jobs || [])[0];
      if (!latest) { setJob(null); setError("No auto-close job found for this combined strategy yet."); return; }
      const detail = await apiGet(`/api/auto-close-combo?id=${latest.id}`);
      setJob(detail.job);
      setLegs(detail.legs || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [groupId]);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 10000);
    return () => clearInterval(timerRef.current);
  }, [load]);

  async function stop() {
    if (!job) return;
    setStopping(true);
    try { await apiDelete(`/api/auto-close-combo?id=${job.id}`); await load(); }
    catch (e) { setError(e.message); }
    finally { setStopping(false); }
  }

  const isTerminal = job ? ["completed", "failed", "stopped"].includes(job.status) : true;
  const preview = useLivePreview(job, legs, isTerminal);

  if (error && !job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>{error}</div></div>;
  if (!job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>;

  const pnl = job.last_equity_usd != null ? Number(job.last_equity_usd) - Number(job.initial_total_usd) : null;

  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, boxShadow: "0 2px 8px rgba(0,0,0,.04)" }}>
      <MonitorHeader subtitle={`Combo — ${legs.length} legs`} status={job.status} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 20 }}>
        <KpiCard label="Initial Collateral" value={fmtCcy(job.initial_total_usd)} color="var(--brand)" />
        <KpiCard label="Current Equity" value={fmtCcy(job.last_equity_usd)} />
        <TargetPnlCard
          pnl={pnl} targetPnl={job.target_pnl} disabled={isTerminal}
          onSave={async (n) => { await apiPatch(`/api/auto-close-combo?id=${job.id}`, { target_pnl: n }); await load(); }}
        />
        <KpiCard label="Final Equity" value={job.final_equity_usd != null ? fmtCcy(job.final_equity_usd) : "—"} />
      </div>
      {!isTerminal && <LivePreviewRow preview={preview} />}
      <table className="ord-table">
        <thead><tr><th>Leg</th><th>Type</th><th>Opt Entry</th><th>Opt Close</th><th>Fut Entry</th><th>Fut Close</th></tr></thead>
        <tbody>
          {legs.map((l) => (
            <tr key={l.id}>
              <td><b>{l.leg_index + 1}. {l.opt_instrument}</b></td>
              <td>{l.leg_type || "—"}</td>
              <td>{l.opt_entry_price != null ? fmtCcy(l.opt_entry_price) : "—"}</td>
              <td>{l.opt_close_price != null ? fmtCcy(l.opt_close_price) : "—"}</td>
              <td>{l.fut_entry_price != null ? fmtCcy(l.fut_entry_price) : "—"}</td>
              <td>{l.fut_close_price != null ? fmtCcy(l.fut_close_price) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!isTerminal && (
        <button className="btn btn-stop" onClick={stop} disabled={stopping} style={{ width: "100%", height: 44, marginTop: 20 }}>
          {stopping ? "Stopping…" : "Stop Monitor"}
        </button>
      )}
      {job.error_msg && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{job.error_msg}</div>}
      <LogPanel logs={job.logs} />
    </div>
  );
}

const ACTIVE_STATUSES = ["active", "closing", "closing_option", "closing_futures"];

// Landing view when opened with no trade_id/group_id — e.g. from the sidebar,
// or after navigating away from Add Strategy/Combined Simulator and losing
// the in-page "Open Monitor" link. Lists every job so a running monitor is
// always reachable, not just from the tab that started it.
function AllJobsList() {
  const [singleJobs, setSingleJobs] = useState(null);
  const [comboJobs, setComboJobs] = useState(null);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([apiGet("/api/auto-close"), apiGet("/api/auto-close-combo")]);
      setSingleJobs(s.jobs || []);
      setComboJobs(c.jobs || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 10000);
    return () => clearInterval(timerRef.current);
  }, [load]);

  if (error) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>{error}</div></div>;
  if (singleJobs == null || comboJobs == null) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>;

  const active = [...singleJobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).map((j) => ({ ...j, kind: "single" })),
    ...comboJobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).map((j) => ({ ...j, kind: "combo" }))];
  const recent = [...singleJobs.filter((j) => !ACTIVE_STATUSES.includes(j.status)).map((j) => ({ ...j, kind: "single" })),
    ...comboJobs.filter((j) => !ACTIVE_STATUSES.includes(j.status)).map((j) => ({ ...j, kind: "combo" }))].slice(0, 15);

  function JobRow({ j }) {
    const href = j.kind === "single" ? `/monitor?trade_id=${encodeURIComponent(j.trade_id)}` : `/monitor?group_id=${encodeURIComponent(j.group_id)}`;
    const label = j.kind === "single" ? `${j.opt_instrument}${j.fut_instrument ? ` + ${j.fut_instrument}` : ""}` : `Combo — ${j.token} (Job #${j.id})`;
    return (
      <tr>
        <td><a href={href} style={{ color: "var(--brand)", fontWeight: 600 }}>{label}</a></td>
        <td><StatusPill status={j.status} /></td>
        <td>{fmtCcy(j.initial_total_usd)}</td>
        <td>+{fmtCcy(j.target_pnl)}</td>
        <td>{j.last_equity_usd != null ? fmtCcy(j.last_equity_usd) : "—"}</td>
        <td>{j.created_at ? new Date(j.created_at).toLocaleString("en-IN") : "—"}</td>
      </tr>
    );
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">🟢 Active ({active.length})</div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="ord-table">
            <thead><tr><th>Strategy</th><th>Status</th><th>Initial</th><th>Target</th><th>Equity</th><th>Started</th></tr></thead>
            <tbody>
              {active.length === 0
                ? <tr><td colSpan={6} className="empty-td">No active monitors — start one from Add Strategy or Combined Simulator.</td></tr>
                : active.map((j) => <JobRow key={`${j.kind}-${j.id}`} j={j} />)}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <div className="card-header">Recent</div>
        <div className="card-body" style={{ padding: 0 }}>
          <table className="ord-table">
            <thead><tr><th>Strategy</th><th>Status</th><th>Initial</th><th>Target</th><th>Equity</th><th>Started</th></tr></thead>
            <tbody>
              {recent.length === 0
                ? <tr><td colSpan={6} className="empty-td">Nothing yet.</td></tr>
                : recent.map((j) => <JobRow key={`${j.kind}-${j.id}`} j={j} />)}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MonitorInner() {
  const searchParams = useSearchParams();
  const tradeId = searchParams.get("trade_id");
  const groupId = searchParams.get("group_id");

  const showListHeader = !tradeId && !groupId;
  return (
    <section className="section">
      {showListHeader && <div className="sec-head">📡 Auto-Close Monitor</div>}
      {showListHeader && <AllJobsList />}
      {tradeId && <SingleLegMonitor tradeId={tradeId} />}
      {groupId && <ComboMonitor groupId={groupId} />}
    </section>
  );
}

export default function MonitorPage() {
  return (
    <Suspense fallback={<div className="section"><div className="sec-head">📡 Auto-Close Monitor</div></div>}>
      <MonitorInner />
    </Suspense>
  );
}

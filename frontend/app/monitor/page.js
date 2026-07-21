"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiGet, apiDelete } from "@/lib/api";

function fmtCcy(v) {
  if (v == null || isNaN(v)) return "—";
  const n = Number(v);
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
}

function StatusPill({ status }) {
  const colors = {
    active: { bg: "#e0f2fe", fg: "#0369a1" },
    closing_option: { bg: "#fef3c7", fg: "#b45309" },
    closing_futures: { bg: "#fef3c7", fg: "#b45309" },
    closing: { bg: "#fef3c7", fg: "#b45309" },
    completed: { bg: "#d1fae5", fg: "#059669" },
    failed: { bg: "#fee2e2", fg: "#b91c1c" },
    stopped: { bg: "#f1f5f9", fg: "#475569" },
  };
  const c = colors[status] || colors.stopped;
  return <span style={{ background: c.bg, color: c.fg, padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{status}</span>;
}

function LogPanel({ logs }) {
  return (
    <div style={{ marginTop: 14, padding: 12, background: "#0b1220", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 11.5, color: "#94a3b8", maxHeight: 320, overflowY: "auto" }}>
      {(!logs || !logs.length) && <div style={{ color: "#5b6b7f" }}>No log entries yet.</div>}
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

async function fetchTickerUsd(instrument) {
  if (!instrument) return null;
  try {
    const t = await apiGet(`/api/deribit/ticker?instrument=${encodeURIComponent(instrument)}`);
    const mark = t.mark_price ?? 0;
    if (isPerpetual(instrument)) return mark;
    const underlying = t.underlying_price ?? t.index_price ?? 1;
    return isCoinSettledOption(instrument) ? mark * underlying : mark;
  } catch (e) { return null; }
}

// dir is the CLOSING direction the job stores (opt_dir/fut_dir): "sell"
// closes a long (original qty was positive), "buy" closes a short
// (original qty was negative) — same convention as server.js's workers.
function signedQty(qty, dir) {
  const mag = Math.abs(Number(qty) || 0);
  return dir === "sell" ? mag : -mag;
}

function legLivePnl(leg, tickers) {
  let pnl = 0;
  if (leg.opt_instrument && Number(leg.opt_qty)) {
    const mark = tickers[leg.opt_instrument];
    if (mark != null) pnl += (mark - Number(leg.opt_entry_price || 0)) * signedQty(leg.opt_qty, leg.opt_dir);
  }
  if (leg.fut_instrument && Number(leg.fut_qty)) {
    const mark = tickers[leg.fut_instrument];
    if (mark != null) pnl += (mark - Number(leg.fut_entry_price || 0)) * signedQty(leg.fut_qty, leg.fut_dir);
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
      const [bal, ...tickerVals] = await Promise.all([
        apiGet(`/api/deribit/collateral?token=${encodeURIComponent(job.token)}${job.account_id ? `&account_id=${job.account_id}` : ""}`),
        ...instruments.map(fetchTickerUsd),
      ]);
      const tickers = {};
      instruments.forEach((inst, i) => { tickers[inst] = tickerVals[i]; });
      const bsPnl = curItems.reduce((s, l) => s + legLivePnl(l, tickers), 0);
      setPreview({ liveEquity: bal && !bal.error ? bal.total_usd : null, bsPnl });
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
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 14 }}>
      <div className="pnl-card pnl-neutral">
        <div className="stat-label">Live Equity</div>
        <div className="stat-value">{preview.liveEquity != null ? fmtCcy(preview.liveEquity) : "—"}</div>
      </div>
      <div className="pnl-card pnl-neutral">
        <div className="stat-label">Live Mark-to-Market PnL</div>
        <div className="stat-value" style={{ color: preview.bsPnl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(preview.bsPnl)}</div>
      </div>
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
    <>
      <div className="card">
        <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Job #{job.id} — {job.opt_instrument}{job.fut_instrument ? ` + ${job.fut_instrument}` : ""}</span>
          <StatusPill status={job.status} />
        </div>
        <div className="card-body">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 14 }}>
            <div className="pnl-card pnl-neutral"><div className="stat-label">Initial Collateral</div><div className="stat-value blue">{fmtCcy(job.initial_total_usd)}</div></div>
            <div className="pnl-card pnl-neutral"><div className="stat-label">Current Equity</div><div className="stat-value">{fmtCcy(job.last_equity_usd)}</div></div>
            <div className="pnl-card pnl-neutral"><div className="stat-label">PnL / Target</div><div className="stat-value" style={{ color: pnl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(pnl)} / +{fmtCcy(job.target_pnl)}</div></div>
            <div className="pnl-card pnl-neutral"><div className="stat-label">Final Equity</div><div className="stat-value">{job.final_equity_usd != null ? fmtCcy(job.final_equity_usd) : "—"}</div></div>
          </div>
          {!isTerminal && <LivePreviewRow preview={preview} />}
          <table className="ord-table">
            <thead><tr><th>Leg</th><th>Entry</th><th>Close</th></tr></thead>
            <tbody>
              <tr><td>Option — {job.opt_instrument}</td><td>{job.opt_entry_price != null ? fmtCcy(job.opt_entry_price) : "—"}</td><td>{job.opt_close_price != null ? fmtCcy(job.opt_close_price) : "—"}</td></tr>
              {job.fut_instrument && <tr><td>Futures — {job.fut_instrument}</td><td>{job.fut_entry_price != null ? fmtCcy(job.fut_entry_price) : "—"}</td><td>{job.fut_close_price != null ? fmtCcy(job.fut_close_price) : "—"}</td></tr>}
            </tbody>
          </table>
          {!isTerminal && <div className="btn-row" style={{ marginTop: 16, gridTemplateColumns: "auto" }}><button className="btn btn-stop" onClick={stop} disabled={stopping}>Stop Monitor</button></div>}
          {job.error_msg && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{job.error_msg}</div>}
          <LogPanel logs={job.logs} />
        </div>
      </div>
    </>
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
    <div className="card">
      <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Combo Job #{job.id} — {legs.length} legs</span>
        <StatusPill status={job.status} />
      </div>
      <div className="card-body">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 14 }}>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Initial Collateral</div><div className="stat-value blue">{fmtCcy(job.initial_total_usd)}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Current Equity</div><div className="stat-value">{fmtCcy(job.last_equity_usd)}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">PnL / Target</div><div className="stat-value" style={{ color: pnl >= 0 ? "var(--green)" : "var(--red)" }}>{fmtCcy(pnl)} / +{fmtCcy(job.target_pnl)}</div></div>
          <div className="pnl-card pnl-neutral"><div className="stat-label">Final Equity</div><div className="stat-value">{job.final_equity_usd != null ? fmtCcy(job.final_equity_usd) : "—"}</div></div>
        </div>
        {!isTerminal && <LivePreviewRow preview={preview} />}
        <table className="ord-table">
          <thead><tr><th>Leg</th><th>Type</th><th>Opt Entry</th><th>Opt Close</th><th>Fut Entry</th><th>Fut Close</th></tr></thead>
          <tbody>
            {legs.map((l) => (
              <tr key={l.id}>
                <td>{l.leg_index + 1}. {l.opt_instrument}</td>
                <td>{l.leg_type || "—"}</td>
                <td>{l.opt_entry_price != null ? fmtCcy(l.opt_entry_price) : "—"}</td>
                <td>{l.opt_close_price != null ? fmtCcy(l.opt_close_price) : "—"}</td>
                <td>{l.fut_entry_price != null ? fmtCcy(l.fut_entry_price) : "—"}</td>
                <td>{l.fut_close_price != null ? fmtCcy(l.fut_close_price) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isTerminal && <div className="btn-row" style={{ marginTop: 16, gridTemplateColumns: "auto" }}><button className="btn btn-stop" onClick={stop} disabled={stopping}>Stop Monitor</button></div>}
        {job.error_msg && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{job.error_msg}</div>}
        <LogPanel logs={job.logs} />
      </div>
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

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">📡 Auto-Close Monitor</div>
        {!tradeId && !groupId && <AllJobsList />}
        {tradeId && <SingleLegMonitor tradeId={tradeId} />}
        {groupId && <ComboMonitor groupId={groupId} />}
      </section>
    </>
  );
}

export default function MonitorPage() {
  return (
    <Suspense fallback={<div className="section"><div className="sec-head">📡 Auto-Close Monitor</div></div>}>
      <MonitorInner />
    </Suspense>
  );
}

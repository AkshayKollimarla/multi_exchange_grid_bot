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

  if (error && !job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>{error}</div></div>;
  if (!job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>;

  const pnl = job.last_equity_usd != null ? Number(job.last_equity_usd) - Number(job.initial_total_usd) : null;
  const isTerminal = ["completed", "failed", "stopped"].includes(job.status);

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

  if (error && !job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>{error}</div></div>;
  if (!job) return <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>Loading…</div></div>;

  const pnl = job.last_equity_usd != null ? Number(job.last_equity_usd) - Number(job.initial_total_usd) : null;
  const isTerminal = ["completed", "failed", "stopped"].includes(job.status);

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

function MonitorInner() {
  const searchParams = useSearchParams();
  const tradeId = searchParams.get("trade_id");
  const groupId = searchParams.get("group_id");

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">📡 Auto-Close Monitor</div>
        {!tradeId && !groupId && (
          <div className="card"><div className="card-body" style={{ color: "var(--muted)" }}>
            Open this page from Add Strategy or Combined Simulator once an auto-close job is running (Execute + Auto-Close).
          </div></div>
        )}
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

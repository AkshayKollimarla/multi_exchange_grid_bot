"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import { fmtCcy, fmtDate } from "@/lib/format";

// Same live-PnL pattern as Monitor (frontend/app/monitor/page.js:191-249) —
// duplicated rather than imported, matching this codebase's convention of
// small per-page helpers instead of a shared lib.
function isPerpetual(instrument) {
  return /-PERPETUAL$/i.test(instrument || "");
}
function isCoinSettledOption(instrument) {
  return !!instrument && !isPerpetual(instrument) && !/_USDC|_USDT/i.test(instrument);
}
function signedQty(qty, dir) {
  const mag = Math.abs(Number(qty) || 0);
  return dir === "sell" ? mag : -mag;
}

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

const ACTIVE_JOB_LABEL = {
  active: "⏳ Waiting on target/stop-loss",
  closing_option: "🔄 Closing…",
  closing_futures: "🔄 Closing…",
  closing: "🔄 Closing…",
};

function StrategyCard({ group, activeJob }) {
  const { groupId, trades } = group;
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(null);

  async function openExit() {
    setExpanded(true);
    setPreviewError(null);
    setPreview(null);
    setLoadingPreview(true);
    try {
      const qs = groupId ? `group_id=${encodeURIComponent(groupId)}` : `trade_id=${trades[0].id}`;
      const resolved = await apiGet(`/api/options-exit/resolve?${qs}`);
      const legs = resolved.legs || [];
      const instruments = [...new Set(legs.flatMap((l) => [l.opt_instrument, l.fut_instrument].filter(Boolean)))];
      const [bal, ...liveVals] = await Promise.all([
        apiGet(`/api/deribit/collateral?token=${encodeURIComponent(resolved.token || "")}${resolved.account_id ? `&account_id=${resolved.account_id}` : ""}`),
        ...instruments.map((inst) => fetchInstrumentLive(inst, resolved.account_id)),
      ]);
      const tickers = {}, avgPrices = {};
      instruments.forEach((inst, i) => { tickers[inst] = liveVals[i].markUsd; avgPrices[inst] = liveVals[i].avgPriceUsd; });
      const totalPnl = legs.reduce((s, l) => s + (l.error ? 0 : legLivePnl(l, tickers, avgPrices)), 0);
      setPreview({
        legs, tickers, avgPrices, totalPnl,
        liveEquity: bal && !bal.error ? bal.total_usd : null,
      });
    } catch (e) {
      setPreviewError(e.message);
    } finally {
      setLoadingPreview(false);
    }
  }

  async function confirmExit() {
    setConfirming(true);
    setConfirmError(null);
    try {
      const body = groupId ? { group_id: groupId } : { trade_id: trades[0].id };
      const res = await apiPost("/api/options-exit", body);
      const qs = res.isCombo ? `group_id=${encodeURIComponent(groupId)}` : `trade_id=${trades[0].id}`;
      router.push(`/monitor?${qs}`);
    } catch (e) {
      setConfirmError(e.message);
      setConfirming(false);
    }
  }

  const t0 = trades[0];
  const allLegsErrored = !!preview && preview.legs.length > 0 && preview.legs.every((l) => l.error);

  return (
    <div className="card" style={{ marginBottom: 16, opacity: activeJob ? 0.72 : 1 }}>
      <div className="card-body">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-display)" }}>{t0.token}</span>
              {groupId && (
                <span style={{ background: "var(--purple)", color: "#fff", padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                  🔗 {trades.length} LEG{trades.length === 1 ? "" : "S"}
                </span>
              )}
              {activeJob && (
                <span style={{ background: "var(--border)", color: "var(--muted)", padding: "2px 10px", borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                  {ACTIVE_JOB_LABEL[activeJob.status] || activeJob.status}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, lineHeight: 1.6 }}>
              {trades.map((t) => (
                <div key={t.id}>
                  {t.option_type} {t.options_strike} · qty {t.opt_entry_qty} · exp {fmtDate(t.expiry)}
                  {Number(t.fut_qty) ? ` · fut ${t.fut_qty}` : ""}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted-2)", marginTop: 4 }}>Entry {fmtDate(t0.entry_date)}</div>
          </div>
          {activeJob ? (
            <a
              href={`/monitor?${groupId ? `group_id=${encodeURIComponent(groupId)}` : `trade_id=${t0.id}`}`}
              className="btn"
              style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--muted)", textDecoration: "none" }}
            >
              View in Monitor
            </a>
          ) : !expanded && (
            <button className="btn" style={{ background: "#dc2626", color: "#fff" }} onClick={openExit}>
              🚪 Options Exit
            </button>
          )}
        </div>

        {!activeJob && expanded && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            {loadingPreview && <div style={{ fontSize: 13, color: "var(--muted)" }}>Fetching live positions…</div>}
            {previewError && <div style={{ fontSize: 13, color: "#dc2626" }}>Error: {previewError}</div>}
            {preview && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 14 }}>
                  <div className="pnl-card pnl-neutral"><div className="stat-label">Live Equity</div><div className="stat-value blue">{preview.liveEquity != null ? fmtCcy(preview.liveEquity) : "—"}</div></div>
                  <div className="pnl-card pnl-neutral"><div className="stat-label">Live Mark-to-Market PnL</div><div className="stat-value" style={{ color: preview.totalPnl >= 0 ? "#16a34a" : "#dc2626" }}>{fmtCcy(preview.totalPnl)}</div></div>
                </div>
                <div style={{ overflowX: "auto", marginBottom: 14 }}>
                  <table className="ord-table">
                    <thead><tr><th>Leg</th><th>Option</th><th>Futures</th><th>Live PnL</th></tr></thead>
                    <tbody>
                      {preview.legs.map((l, i) => (
                        <tr key={i}>
                          <td>{l.leg_type || `Leg ${i + 1}`}</td>
                          {l.error ? (
                            <td colSpan={3} style={{ color: "#dc2626" }}>{l.error}</td>
                          ) : (
                            <>
                              <td>{l.opt_instrument}</td>
                              <td>{l.fut_instrument || "—"}</td>
                              <td style={{ color: legLivePnl(l, preview.tickers, preview.avgPrices) >= 0 ? "#16a34a" : "#dc2626", fontWeight: 600 }}>
                                {fmtCcy(legLivePnl(l, preview.tickers, preview.avgPrices))}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, padding: "10px 12px", background: "var(--red-soft)", borderRadius: 8 }}>
                  ⚠️ Confirming closes every leg immediately — option leg(s) at the best available maker price (re-quoting until filled), futures at market. This cannot be undone.
                </div>
                {confirmError && <div style={{ fontSize: 12, color: "#dc2626", marginBottom: 8 }}>Error: {confirmError}</div>}
                <div style={{ display: "flex", gap: 10 }}>
                  <button className="btn" style={{ background: "#dc2626", color: "#fff" }} disabled={confirming || allLegsErrored} onClick={confirmExit}>
                    {confirming ? "Exiting…" : "Confirm Exit — Close All Legs Now"}
                  </button>
                  <button className="btn" style={{ background: "transparent", border: "1px solid var(--border-2)", color: "var(--ink)" }} disabled={confirming} onClick={() => setExpanded(false)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OptionsExitPage() {
  const [trades, setTrades] = useState([]);
  const [activeJobs, setActiveJobs] = useState({ byTradeId: new Map(), byGroupId: new Map() });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Bulk-fetch every job (no id/trade_id/group_id) rather than one
      // lookup per card — a strategy already mid-exit (or still waiting on
      // its own target/stop-loss) shouldn't offer a second, confusing Exit
      // button; it should show as already-in-progress instead.
      const [tradesRes, singleJobs, comboJobs] = await Promise.all([
        apiGet(`/api/options-db/trades?status=open&limit=9999`),
        apiGet(`/api/auto-close`).catch(() => ({ jobs: [] })),
        apiGet(`/api/auto-close-combo`).catch(() => ({ jobs: [] })),
      ]);
      setTrades(tradesRes.trades || []);
      const SINGLE_ACTIVE = ["active", "closing_option", "closing_futures"];
      const COMBO_ACTIVE = ["active", "closing"];
      const byTradeId = new Map();
      for (const j of singleJobs.jobs || []) {
        if (j.trade_id && SINGLE_ACTIVE.includes(j.status)) byTradeId.set(j.trade_id, j);
      }
      const byGroupId = new Map();
      for (const j of comboJobs.jobs || []) {
        if (j.group_id && COMBO_ACTIVE.includes(j.status)) byGroupId.set(j.group_id, j);
      }
      setActiveJobs({ byTradeId, byGroupId });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Group by group_id, same as Options Dashboard (frontend/app/options-dashboard/page.js:128-145).
  const groups = [];
  const seen = new Set();
  for (const t of trades) {
    if (t.group_id) {
      if (seen.has(t.group_id)) continue;
      seen.add(t.group_id);
      groups.push({ groupId: t.group_id, trades: trades.filter((x) => x.group_id === t.group_id) });
    } else {
      groups.push({ groupId: null, trades: [t] });
    }
  }

  return (
    <section className="section">
      <div className="sec-head">🚪 Options Exit</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>
        Every open strategy. Exit fetches live positions and PnL, then closes every leg at once — options via maker chase, futures at market.
      </div>
      {loading && <div style={{ color: "var(--muted)" }}>Loading…</div>}
      {!loading && error && <div style={{ color: "#dc2626" }}>Error: {error}</div>}
      {!loading && !error && groups.length === 0 && (
        <div style={{ color: "var(--muted)" }}>No open strategies. <a href="/add-strategy">Add one.</a></div>
      )}
      {!loading && !error && groups.map((g) => {
        const activeJob = g.groupId ? activeJobs.byGroupId.get(g.groupId) : activeJobs.byTradeId.get(g.trades[0].id);
        return <StrategyCard key={g.groupId || g.trades[0].id} group={g} activeJob={activeJob} />;
      })}
    </section>
  );
}

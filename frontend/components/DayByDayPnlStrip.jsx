"use client";

import { fmtCcy } from "@/lib/format";

// Horizontal day-by-day PnL strip — one cell per day from today through
// expiry, colored green/red by sign, with a callout for the first day the
// sign flips relative to today (if any). Shared by Add Strategy (single
// leg) and Combined Simulator (multi-leg) — both build `rows` via
// dayByDayFlatPnl() in lib/optionsDerived.js and just render them here.
export default function DayByDayPnlStrip({ rows }) {
  if (!rows || rows.length < 2) return null;

  const startPositive = rows[0].pnl >= 0;
  const flipIdx = rows.findIndex((r, i) => i > 0 && (r.pnl >= 0) !== startPositive);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">📅 Day-by-Day PnL (theta decay, price held flat at today's level)</div>
      <div className="card-body">
        {flipIdx > 0 ? (
          <div style={{ fontSize: 12.5, marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: startPositive ? "var(--red-soft)" : "var(--green-soft)", color: startPositive ? "var(--red-2)" : "var(--green-2)", fontWeight: 600 }}>
            If price stays where it is today, PnL flips {startPositive ? "negative" : "positive"} on{" "}
            <b>Day {rows[flipIdx].day}</b> ({rows[flipIdx].date.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}).
          </div>
        ) : (
          <div style={{ fontSize: 12.5, marginBottom: 12, color: "var(--muted)" }}>
            {startPositive ? "Stays positive" : "Stays negative"} every day through expiry if price holds flat.
          </div>
        )}
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          {rows.map((r) => (
            <div
              key={r.day}
              style={{
                minWidth: 84, padding: "10px 12px", borderRadius: 8, textAlign: "center", flexShrink: 0,
                background: r.pnl >= 0 ? "var(--green-soft)" : "var(--red-soft)",
                border: r.day === 0 ? "2px solid var(--brand)" : "1px solid transparent",
              }}
            >
              <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 600, whiteSpace: "nowrap" }}>
                {r.day === 0 ? "Today" : `Day ${r.day}`}
              </div>
              <div style={{ fontSize: 9.5, color: "var(--muted)", marginBottom: 2 }}>
                {r.date.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: r.pnl >= 0 ? "var(--green-2)" : "var(--red-2)", whiteSpace: "nowrap" }}>
                {fmtCcy(r.pnl)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

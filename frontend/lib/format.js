// Ported 1:1 from index.html (odbFmtCcy / odbFmtDate) so numbers/dates
// render identically to the old frontend during the incremental migration.

export function fmtCcy(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || Number.isNaN(n)) return "—";
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDate(d) {
  if (!d) return "—";
  const s = String(d);
  const dt = new Date(s.length === 10 ? s + "T00:00:00" : s.replace(" ", "T"));
  if (Number.isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

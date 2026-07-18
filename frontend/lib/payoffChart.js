import { bsPrice, strikeNumber } from "./blackScholes";

// Ported from index.html's odbAnRenderPayoff — same math, same SVG markup,
// just returns { svg, note } instead of writing directly into the DOM.
export function renderPayoffSvg(trade, underlyingInput, ivInput) {
  const K = strikeNumber(trade.options_strike);
  const entryPrice = Math.abs(parseFloat(trade.opt_entry_price) || 0);
  const qty = parseFloat(trade.opt_entry_qty) || 1;
  const optType = (trade.option_type || "PUT").toUpperCase();
  const sigma = Math.max(0.01, (parseFloat(ivInput) || 30) / 100);
  const S_now = parseFloat(underlyingInput) || K;

  const expiryStr = trade.expiry ? String(trade.expiry).slice(0, 10) : "";
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysLeft = expiryStr
    ? Math.max(0, Math.round((new Date(expiryStr + "T00:00:00") - new Date(todayStr + "T00:00:00")) / 86400000))
    : 0;
  const T_now = daysLeft / 365;

  const rangeMin = K * 0.6, rangeMax = K * 1.4, N = 80;
  const prices = Array.from({ length: N + 1 }, (_, i) => rangeMin + (i / N) * (rangeMax - rangeMin));
  const expiryLine = prices.map((S) => {
    const iv = optType === "CALL" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return (iv - entryPrice) * qty;
  });
  const todayLine = prices.map((S, i) =>
    T_now > 0 ? (bsPrice(optType.toLowerCase(), S, K, T_now, sigma, 0.05) - entryPrice) * qty : expiryLine[i]
  );
  const oneDayLine = prices.map((S, i) => {
    const T1 = Math.max(0, (daysLeft - 1) / 365);
    return T1 > 0 ? (bsPrice(optType.toLowerCase(), S, K, T1, sigma, 0.05) - entryPrice) * qty : expiryLine[i];
  });

  const W = 700, H = 300, PAD = { l: 60, r: 16, t: 26, b: 44 };
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
  const allPnls = [...expiryLine, ...todayLine, ...oneDayLine].filter(isFinite);
  const rawMin = Math.min(...allPnls), rawMax = Math.max(...allPnls), padding = (rawMax - rawMin) * 0.08 || 1;
  const pnlMin = rawMin - padding, pnlMax = rawMax + padding, pnlRange = pnlMax - pnlMin;
  const xS = (p) => PAD.l + ((p - rangeMin) / (rangeMax - rangeMin)) * cw;
  const yS = (v) => PAD.t + ((pnlMax - v) / pnlRange) * ch;
  const toPath = (line) => line.map((v, i) => `${i === 0 ? "M" : "L"}${xS(prices[i]).toFixed(1)},${yS(v).toFixed(1)}`).join(" ");
  const Y_GRIDS = 5, yStep = pnlRange / Y_GRIDS, yGrid = Array.from({ length: Y_GRIDS + 1 }, (_, i) => pnlMin + i * yStep);
  const X_GRIDS = 6, xStep = (rangeMax - rangeMin) / X_GRIDS, xGrid = Array.from({ length: X_GRIDS + 1 }, (_, i) => rangeMin + i * xStep);
  const zeroY = yS(0), zeroInView = zeroY >= PAD.t && zeroY <= PAD.t + ch;
  const S_inRange = S_now >= rangeMin && S_now <= rangeMax;
  const idxAtS = Math.round(((S_now - rangeMin) / (rangeMax - rangeMin)) * N);
  const todayPnlAtCurrent = T_now > 0
    ? (bsPrice(optType.toLowerCase(), S_now, K, T_now, sigma, 0.05) - entryPrice) * qty
    : expiryLine[Math.max(0, Math.min(N, idxAtS))];
  const tick = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));
  const ptick = (v) => (v >= 1000 ? (v / 1000).toFixed(0) + "K" : v.toFixed(0));

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:320px;border:1px solid var(--border,#e5e7eb);border-radius:10px;">`;
  svg += `<rect x="${PAD.l}" y="${PAD.t}" width="${cw}" height="${ch}" fill="#f8fafc" rx="4"/>`;
  for (const y of yGrid) svg += `<line x1="${PAD.l}" y1="${yS(y).toFixed(1)}" x2="${PAD.l + cw}" y2="${yS(y).toFixed(1)}" stroke="#e2e8f0"/><text x="${PAD.l - 6}" y="${yS(y).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="#94a3b8">${tick(y)}</text>`;
  for (const x of xGrid) svg += `<line x1="${xS(x).toFixed(1)}" y1="${PAD.t}" x2="${xS(x).toFixed(1)}" y2="${PAD.t + ch}" stroke="#e2e8f0"/><text x="${xS(x).toFixed(1)}" y="${PAD.t + ch + 15}" text-anchor="middle" font-size="10" fill="#94a3b8">${ptick(x)}</text>`;
  if (zeroInView) svg += `<line x1="${PAD.l}" y1="${zeroY.toFixed(1)}" x2="${PAD.l + cw}" y2="${zeroY.toFixed(1)}" stroke="#475569" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.5"/>`;
  svg += `<line x1="${xS(K).toFixed(1)}" y1="${PAD.t}" x2="${xS(K).toFixed(1)}" y2="${PAD.t + ch}" stroke="#8b5cf6" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.8"/><text x="${xS(K).toFixed(1)}" y="${PAD.t - 8}" text-anchor="middle" font-size="10" fill="#8b5cf6" font-weight="700">K=${ptick(K)}</text>`;
  if (underlyingInput && S_inRange) svg += `<line x1="${xS(S_now).toFixed(1)}" y1="${PAD.t}" x2="${xS(S_now).toFixed(1)}" y2="${PAD.t + ch}" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.8"/>`;
  svg += `<path d="${toPath(expiryLine)}" fill="none" stroke="#f97316" stroke-width="2.5"/>`;
  if (daysLeft > 1) svg += `<path d="${toPath(oneDayLine)}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-dasharray="6,3"/>`;
  if (T_now > 0) svg += `<path d="${toPath(todayLine)}" fill="none" stroke="#0d9488" stroke-width="2.5"/>`;
  if (underlyingInput && S_inRange && T_now > 0) svg += `<circle cx="${xS(S_now).toFixed(1)}" cy="${yS(todayPnlAtCurrent).toFixed(1)}" r="5" fill="#0d9488" stroke="white" stroke-width="2"/>`;
  svg += `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t + ch}" stroke="#cbd5e1"/><line x1="${PAD.l}" y1="${PAD.t + ch}" x2="${PAD.l + cw}" y2="${PAD.t + ch}" stroke="#cbd5e1"/>`;
  svg += `<text x="${PAD.l + cw / 2}" y="${H - 4}" text-anchor="middle" font-size="11" fill="#64748b" font-style="italic">Underlying price</text>`;
  svg += `<g transform="translate(${PAD.l + cw - 300}, ${PAD.t + 6})"><rect x="0" y="0" width="290" height="20" fill="white" rx="3" stroke="#e2e8f0"/>
    <line x1="8" y1="10" x2="26" y2="10" stroke="#f97316" stroke-width="2.5"/><text x="30" y="14" font-size="10" fill="#475569">Expiry P/L</text>`;
  if (T_now > 0) svg += `<line x1="108" y1="10" x2="126" y2="10" stroke="#0d9488" stroke-width="2.5"/><text x="130" y="14" font-size="10" fill="#475569">Today P/L (${daysLeft}d)</text>`;
  if (daysLeft > 1) svg += `<line x1="218" y1="10" x2="236" y2="10" stroke="#3b82f6" stroke-width="2" stroke-dasharray="5,3"/><text x="240" y="14" font-size="10" fill="#475569">1-day P/L</text>`;
  svg += `</g></svg>`;

  const note = underlyingInput
    ? { text: `P/L at ${Number(underlyingInput).toLocaleString()}: ${todayPnlAtCurrent >= 0 ? "+" : ""}${todayPnlAtCurrent.toFixed(2)}`, positive: todayPnlAtCurrent >= 0 }
    : null;

  return { svg, note };
}

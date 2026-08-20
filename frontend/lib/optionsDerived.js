import { strikeNumber, bsPrice } from "./blackScholes";

function f(v) { const n = parseFloat(v); return isNaN(n) ? 0.0 : n; }
function divSafe(a, b) { return b === 0 ? 0.0 : a / b; }

// Ported 1:1 from index.html's odbComputeDerived — mirrors db.js's
// computeOptionsDerived exactly; used here only for the live client-side
// preview, the server always recomputes authoritatively on save.
export function computeDerived(d) {
  const entryDate = d.entry_date ? new Date(d.entry_date) : new Date();
  const expiry = d.expiry ? new Date(d.expiry) : null;
  let days_to_expiry = 0;
  if (expiry && !isNaN(entryDate) && !isNaN(expiry)) days_to_expiry = Math.round((expiry - entryDate) / 86400000);

  const opt_entry_qty = f(d.opt_entry_qty), opt_entry_price = f(d.opt_entry_price);
  const fut_qty = f(d.fut_qty), fut_entry_price = f(d.fut_entry_price);
  const upside_distance = f(d.upside_distance), down_distance = f(d.down_distance);
  const basket_distance = f(d.basket_distance), basket_loss = f(d.basket_loss);
  const market_making_pl = f(d.market_making_pl), investment = f(d.investment);
  const option_type = (d.option_type || "PUT").toUpperCase();
  const strike_num = strikeNumber(d.options_strike);

  // opt_entry_qty is negative for SHORT legs, positive for LONG — theta decay
  // is a gain for a short seller and a loss for a long holder, i.e. the
  // opposite sign of the raw qty*price product.
  const total_theta_gain_loss = -(opt_entry_qty * opt_entry_price);
  const per_day_theta_gain_loss = divSafe(total_theta_gain_loss, days_to_expiry);
  const total_baskets = divSafe(down_distance, basket_distance);

  const blbd = divSafe(basket_loss, basket_distance);
  const mm = basket_loss * total_baskets + (blbd + blbd / 2 + blbd / 2) * (down_distance / 2);
  const total_mm_loss = -mm;

  const upper_limit = fut_entry_price + upside_distance;
  const lower_limit = fut_entry_price - down_distance;

  let upside_opt_pnl, down_opt_pnl;
  if (option_type === "CALL") {
    const breakeven = strike_num + opt_entry_price;
    upside_opt_pnl = breakeven > upper_limit ? -(opt_entry_price * opt_entry_qty) : (upper_limit - breakeven) * opt_entry_qty;
    down_opt_pnl = opt_entry_price * -opt_entry_qty;
  } else {
    const net_strike = strike_num - opt_entry_price;
    down_opt_pnl = net_strike < lower_limit ? -(opt_entry_price * opt_entry_qty) : (net_strike - lower_limit) * opt_entry_qty;
    upside_opt_pnl = opt_entry_price * -opt_entry_qty;
  }

  const upside_fut_pnl = fut_qty * upside_distance;
  const downside_fut_pnl = -(fut_qty * down_distance);
  const estimated_upside_net_pnl = total_mm_loss + upside_opt_pnl + upside_fut_pnl;
  const estimated_downside_net_pnl = total_mm_loss + down_opt_pnl + downside_fut_pnl;
  const apy = investment ? (market_making_pl / investment) * 365 * 100 : 0;

  return {
    days_to_expiry, total_theta_gain_loss, per_day_theta_gain_loss, total_baskets, total_mm_loss,
    upper_limit, lower_limit, upside_opt_pnl, down_opt_pnl, upside_fut_pnl, downside_fut_pnl,
    estimated_upside_net_pnl, estimated_downside_net_pnl, apy,
  };
}

// Option PnL "if the underlying hits Starget today" — full Black-Scholes
// value (keeps time value) rather than computeDerived()'s upside/down_opt_pnl,
// which price the option at intrinsic value only (i.e. assume it's held to
// expiry). Shared by the per-leg card and the combined-simulator page's
// aggregate "Today BS Upside/Downside" totals, so both stay in sync.
// Same Black-Scholes math as legBsTodayPnl, but at an arbitrary number of
// days from now instead of always "today" — the day-by-day PnL projection
// (Combined Simulator / Add Strategy) calls this once per day between now
// and expiry to show how theta decay alone moves PnL as time passes,
// holding the underlying flat at Starget. daysFromNow=0 is today, matching
// legBsTodayPnl exactly.
export function legBsPnlOnDay(form, optType, Starget, daysFromNow) {
  const K = strikeNumber(form.options_strike), ep = parseFloat(form.opt_entry_price) || 0, qty = parseFloat(form.opt_entry_qty) || 0;
  if (!K || !qty) return 0;
  const sigma = Math.max(0.01, (parseFloat(form.iv) || 30) / 100);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expD = form.expiry ? new Date(form.expiry + "T00:00:00") : null;
  const dte = expD && !isNaN(expD) ? Math.max(0, Math.round((expD - today) / 86400000)) : 0;
  const remaining = Math.max(0, dte - Math.max(0, Math.round(daysFromNow || 0)));
  const T = remaining / 365;
  if (T > 0) return (bsPrice(optType.toLowerCase(), Starget, K, T, sigma, 0.05) - ep) * qty;
  const intrinsic = optType === "CALL" ? Math.max(Starget - K, 0) : Math.max(K - Starget, 0);
  return (intrinsic - ep) * qty;
}

export function legBsTodayPnl(form, optType, Starget) {
  return legBsPnlOnDay(form, optType, Starget, 0);
}

// Projects combined PnL day-by-day from today through the furthest leg's
// expiry, holding each leg's underlying flat at its own current price
// (form.fut_entry_price) the whole time — futures PnL is inherently $0 in
// this scenario since price never moves, so only options' theta decay
// changes the total. Answers "on which day does my PnL turn positive (or
// negative)" if the market just sits still. legs: [{form, optType}]. mmLoss
// is a constant (not time- or price-dependent) added to every day.
export function dayByDayFlatPnl(legs, mmLoss, maxDays) {
  const days = Math.max(0, Math.round(maxDays || 0));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = [];
  for (let day = 0; day <= days; day++) {
    const pnl = legs.reduce((s, l) => {
      const S = parseFloat(l.form.fut_entry_price) || 0;
      return s + legBsPnlOnDay(l.form, l.optType, S, day);
    }, 0) + (mmLoss || 0);
    rows.push({ day, date: new Date(today.getTime() + day * 86400000), pnl });
  }
  return rows;
}

// Day-by-day PnL if the underlying makes a fixed move — each leg's own
// Upside Distance / Down Distance — by that day, instead of dayByDayFlatPnl's
// flat price. Option leg uses BS (time value shrinks as `day` advances,
// same as dayByDayFlatPnl); futures leg is linear in distance so its PnL is
// constant across days once the move has happened, matching the existing
// bsUpsideCombined/bsDownsideCombined "Today BS" totals' fut+mm shape.
// Answers "if the price moves $100 up (or down) by day N, what's my PnL
// that day." direction: "upside" | "downside".
export function dayByDayMovePnl(legs, mmLoss, maxDays, direction) {
  const days = Math.max(0, Math.round(maxDays || 0));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = [];
  for (let day = 0; day <= days; day++) {
    const pnl = legs.reduce((s, l) => {
      const entry = parseFloat(l.form.fut_entry_price) || 0;
      const futQty = parseFloat(l.form.fut_qty) || 0;
      const dist = direction === "downside" ? (parseFloat(l.form.down_distance) || 0) : (parseFloat(l.form.upside_distance) || 0);
      const S = direction === "downside" ? entry - dist : entry + dist;
      const futPnl = direction === "downside" ? -(futQty * dist) : futQty * dist;
      return s + legBsPnlOnDay(l.form, l.optType, S, day) + futPnl;
    }, 0) + (mmLoss || 0);
    rows.push({ day, date: new Date(today.getTime() + day * 86400000), pnl });
  }
  return rows;
}

export function toInputDate(d) {
  if (!d && d !== 0) return "";
  const dt = typeof d === "number" ? new Date(d) : (() => {
    const s = String(d);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00");
    return new Date(s.replace(" ", "T"));
  })();
  if (isNaN(dt)) return "";
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

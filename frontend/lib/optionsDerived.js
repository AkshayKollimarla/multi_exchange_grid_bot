import { strikeNumber } from "./blackScholes";

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

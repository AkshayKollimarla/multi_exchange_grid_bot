import { apiGet, apiPost, apiDelete } from "./api";

export function placeOrder({ instrument, qty, direction, price, isMarket = false, postOnly = true }) {
  return apiPost("/api/deribit-order", { instrument, qty, direction, price, is_market: isMarket, post_only: postOnly });
}

export function getOrderState(orderId) {
  return apiGet(`/api/deribit-order?order_id=${encodeURIComponent(orderId)}`);
}

export function cancelOrder(orderId) {
  return apiDelete(`/api/deribit-order?order_id=${encodeURIComponent(orderId)}`);
}

// Coin-settled instruments quote mark/bid/ask in the underlying coin, not
// USD — same conversion server.js's execute endpoint applies before placing
// an order. isCoinSettled comes from the instrument's `settlement` tag in
// /api/deribit/instruments ("coin" vs "usdc").
export async function getTickerMid(instrument, isCoinSettled) {
  const t = await apiGet(`/api/deribit/ticker?instrument=${encodeURIComponent(instrument)}`);
  const underlying = t.underlying_price ?? t.index_price ?? 1;
  const bid = t.best_bid_price || 0, ask = t.best_ask_price || 0;
  const midRaw = bid > 0 && ask > 0 ? (bid + ask) / 2 : (t.mark_price || 0);
  const toUsd = isCoinSettled ? underlying : 1;
  return {
    mid_price_raw: midRaw,
    mid_price_usd: midRaw * toUsd,
    mark_price_usd: (t.mark_price ?? 0) * toUsd,
    underlying_price: underlying,
    mark_iv: t.mark_iv ?? null,
  };
}

export function getCollateral(token) {
  return apiGet(`/api/deribit/collateral?token=${encodeURIComponent(token)}`);
}

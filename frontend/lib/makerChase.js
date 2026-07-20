import { placeOrder, getOrderState, cancelOrder, getTickerMid } from "./deribitOrder";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const REQUOTE_THRESHOLD = 0.00005;
const POLL_MS = 5000;

// Places a limit order at the current mid, chases (re-quotes) if the mid
// drifts more than REQUOTE_THRESHOLD before it fills. post_only is OFF —
// see server.js's /api/deribit-order comment: a limit priced exactly at a
// fresh mid can't normally cross the book, but if the market ticks before
// the order lands, this lets it fill as a taker instead of being rejected
// and needing a manual retry.
//
// onLog(msg) is called at every step. isCancelled() is polled between waits
// so the caller can abort a still-open order. Returns the current USD mark
// price once filled (used for the saved entry-price field).
export async function runOptionEntry({ instrument, qty, isCoinSettled, onLog, isCancelled, accountId }) {
  const dir = qty > 0 ? "buy" : "sell";
  const log = onLog || (() => {});
  const cancelled = isCancelled || (() => false);

  async function place(mid) {
    log(`Placing ${dir} ${Math.abs(qty)}x ${instrument} @ mid ${mid.toFixed(5)}`);
    const data = await placeOrder({ instrument, qty: Math.abs(qty), direction: dir, price: mid, isMarket: false, postOnly: false, accountId });
    if (!data.order_id) throw new Error("Option order failed: no order_id returned");
    log(`Order #${String(data.order_id).slice(-8)} — ${data.order_state}`);
    return { orderId: data.order_id, mid, filled: data.order_state === "filled" };
  }

  const initial = await getTickerMid(instrument, isCoinSettled);
  if (!initial.mid_price_raw) throw new Error(`Could not get option mid price for ${instrument}`);

  let { orderId, mid, filled } = await place(initial.mid_price_raw);
  if (filled) log("Option filled immediately!");

  while (!filled) {
    if (cancelled()) { await cancelOrder(orderId, accountId).catch(() => {}); throw new Error("Cancelled by user"); }
    await sleep(POLL_MS);
    if (cancelled()) { await cancelOrder(orderId, accountId).catch(() => {}); throw new Error("Cancelled by user"); }

    const state = await getOrderState(orderId, accountId);
    if (state.order_state === "filled") { log("Option filled!"); filled = true; break; }

    const t = await getTickerMid(instrument, isCoinSettled);
    const newMid = t.mid_price_raw || 0;
    if (newMid > 0 && Math.abs(newMid - mid) > REQUOTE_THRESHOLD) {
      log(`Mid ${mid.toFixed(5)} → ${newMid.toFixed(5)}, re-placing`);
      await cancelOrder(orderId, accountId).catch(() => {});
      ({ orderId, mid, filled } = await place(newMid));
    } else {
      log(`Waiting — order open @ ${mid.toFixed(5)}`);
    }
  }

  try {
    const t = await getTickerMid(instrument, isCoinSettled);
    return t.mark_price_usd ?? null;
  } catch (e) { return null; }
}

export async function runFuturesEntry({ instrument, qty, onLog, accountId }) {
  const dir = qty > 0 ? "buy" : "sell";
  const log = onLog || (() => {});
  log(`Placing futures MARKET ${dir} ${Math.abs(qty)}x ${instrument}`);
  const data = await placeOrder({ instrument, qty: Math.abs(qty), direction: dir, isMarket: true, accountId });
  log(`Futures filled @ ${data.price ?? "market"}`);
  return data.price ?? null;
}

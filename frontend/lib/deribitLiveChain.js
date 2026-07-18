import { toInputDate } from "./optionsDerived";

// React-friendly version of index.html's odbLive* engine — instead of a
// global mutable `odbLiveInstruments` array, these operate on an instruments
// array passed in (fetched once at the page level via /api/deribit/instruments
// and held in React state), so multiple leg cards can share one fetch
// without any shared mutable global.

export function tokensFor(instruments) {
  return [...new Set(instruments.map((i) => i.base_currency))].sort();
}

export function tokenInstruments(instruments, token) {
  return instruments.filter((i) => i.base_currency === token);
}

export function expiriesFor(instruments, token) {
  return [...new Set(tokenInstruments(instruments, token).map((i) => toInputDate(i.expiration_timestamp)))].sort();
}

// BTC/ETH list the same strike under both the coin-settled and USDC-settled
// chains (merged server-side) — dedupe so each strike shows once.
export function strikesFor(instruments, token, expiryDateStr, type) {
  const strikes = tokenInstruments(instruments, token)
    .filter((i) => toInputDate(i.expiration_timestamp) === expiryDateStr && i.option_type === String(type).toLowerCase())
    .map((i) => i.strike);
  return [...new Set(strikes)].sort((a, b) => a - b);
}

export function findInstrument(instruments, token, expiryDateStr, type, strike) {
  return tokenInstruments(instruments, token).find(
    (i) =>
      toInputDate(i.expiration_timestamp) === expiryDateStr &&
      i.option_type === String(type).toLowerCase() &&
      String(i.strike) === String(strike)
  );
}

import { toInputDate } from "./optionsDerived";

// Mirrors deribitLiveChain.js's shape, adapted to Alpaca's option-contract
// fields and fetch model. Deribit's chain is fetched once for ALL currencies
// and filtered client-side by base_currency; Alpaca's isn't — the chain is
// fetched PER underlying (/api/alpaca/instruments?underlying=BITO), so
// there's no tokensFor() here — the underlying list is this curated,
// crypto-proxy-ETF set instead, and the page fetches a fresh `instruments`
// array whenever the selected underlying changes.

// Curated proxy-ETF list — Alpaca has no crypto options, so a crypto-hedged
// options leg has to go through an ETF that tracks the same underlying.
export const ALPACA_UNDERLYINGS = [
  { value: "BITO", label: "BITO — ProShares Bitcoin Strategy ETF (BTC proxy)" },
  { value: "IBIT", label: "IBIT — iShares Bitcoin Trust (BTC proxy)" },
  { value: "ETHA", label: "ETHA — iShares Ethereum Trust (ETH proxy)" },
];

export function expiriesFor(instruments) {
  return [...new Set(instruments.map((i) => toInputDate(i.expiration_date)))].sort();
}

export function strikesFor(instruments, expiryDateStr, type) {
  const strikes = instruments
    .filter((i) => toInputDate(i.expiration_date) === expiryDateStr && i.type === String(type).toLowerCase())
    .map((i) => parseFloat(i.strike_price));
  return [...new Set(strikes)].sort((a, b) => a - b);
}

export function findInstrument(instruments, expiryDateStr, type, strike) {
  return instruments.find(
    (i) =>
      toInputDate(i.expiration_date) === expiryDateStr &&
      i.type === String(type).toLowerCase() &&
      String(parseFloat(i.strike_price)) === String(parseFloat(strike))
  );
}

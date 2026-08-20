import { toInputDate } from "./optionsDerived";

// Mirrors deribitLiveChain.js's shape, adapted to Alpaca's option-contract
// fields and fetch model. Deribit's chain is fetched once for ALL currencies
// and filtered client-side by base_currency; Alpaca's isn't — the chain is
// fetched PER underlying (/api/alpaca/instruments?underlying=BITO), so
// there's no tokensFor() here — the underlying is free-text (any
// Alpaca-tradable ticker, not just crypto-proxy ETFs), and the page fetches
// a fresh `instruments` array whenever it changes.

// Quick-pick suggestions only (rendered as a <datalist>, not a fixed
// dropdown) — the underlying field accepts ANY ticker Alpaca lists options
// for. Crypto-proxy ETFs first since that's this app's main use case
// (Alpaca has no options on crypto directly), then a few common stocks.
export const ALPACA_UNDERLYING_SUGGESTIONS = [
  { value: "BITO", label: "BITO — ProShares Bitcoin Strategy ETF (BTC proxy)" },
  { value: "IBIT", label: "IBIT — iShares Bitcoin Trust (BTC proxy)" },
  { value: "ETHA", label: "ETHA — iShares Ethereum Trust (ETH proxy)" },
  { value: "QQQ", label: "QQQ — Invesco Nasdaq-100 ETF" },
  { value: "SPY", label: "SPY — SPDR S&P 500 ETF" },
  { value: "HOOD", label: "HOOD — Robinhood Markets" },
  { value: "BE", label: "BE — Bloom Energy" },
  { value: "PLTR", label: "PLTR — Palantir Technologies" },
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

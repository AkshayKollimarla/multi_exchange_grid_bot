// Ported from index.html's loadSymbols() — fetches the live market list
// directly from each exchange's public API (browser-side, no auth needed),
// same as the classic dashboard. HIP-3 dex markets aren't included in this
// simplified New Bot form; that stays on the classic dashboard for now.
export async function loadSymbolsFor(priceSource, testnetFlags = {}) {
  const { deribitTestnet, hyperliquidTestnet } = testnetFlags;

  if (priceSource === "binance_futures") {
    const data = await fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo");
    return data.symbols
      .filter((s) => s.status === "TRADING")
      .map((s) => ({ ccxt: `${s.baseAsset}/${s.quoteAsset}:${s.quoteAsset}`, native: s.symbol }))
      .sort((a, b) => a.native.localeCompare(b.native));
  }

  if (priceSource === "binance_coinm") {
    const data = await fetchJson("https://dapi.binance.com/dapi/v1/exchangeInfo");
    return data.symbols
      .filter((s) => s.contractStatus === "TRADING")
      .map((s) => ({ ccxt: `${s.baseAsset}/USD:${s.baseAsset}`, native: s.symbol }))
      .sort((a, b) => a.native.localeCompare(b.native));
  }

  if (priceSource === "deribit") {
    const host = deribitTestnet ? "test.deribit.com" : "www.deribit.com";
    const currencies = ["BTC", "ETH", "SOL", "XRP"];
    const all = [];
    for (const c of currencies) {
      try {
        const j = await fetchJson(`https://${host}/api/v2/public/get_instruments?currency=${c}&kind=future&expired=false`);
        (j.result || []).filter((i) => i.instrument_name.endsWith("-PERPETUAL")).forEach((i) => {
          const settle = i.settlement_currency || i.quote_currency || c;
          all.push({ ccxt: `${i.base_currency}/${i.quote_currency}:${settle}`, native: i.instrument_name });
        });
      } catch (e) { /* skip this currency, try the rest */ }
    }
    try {
      const j = await fetchJson(`https://${host}/api/v2/public/get_instruments?currency=USDC&kind=future&expired=false`);
      (j.result || []).filter((i) => i.instrument_name.endsWith("-PERPETUAL")).forEach((i) => {
        const settle = i.settlement_currency || i.quote_currency || "USDC";
        all.push({ ccxt: `${i.base_currency}/${i.quote_currency}:${settle}`, native: i.instrument_name });
      });
    } catch (e) { /* ignore */ }
    return all.sort((a, b) => a.native.localeCompare(b.native));
  }

  if (priceSource === "deribit_spot") {
    const host = deribitTestnet ? "test.deribit.com" : "www.deribit.com";
    const currencies = ["BTC", "ETH", "SOL", "XRP", "USDC"];
    const all = [], seen = new Set();
    for (const c of currencies) {
      try {
        const j = await fetchJson(`https://${host}/api/v2/public/get_instruments?currency=${c}&kind=spot&expired=false`);
        (j.result || []).forEach((i) => {
          if (seen.has(i.instrument_name)) return;
          seen.add(i.instrument_name);
          all.push({ ccxt: `${i.base_currency}/${i.quote_currency}`, native: i.instrument_name });
        });
      } catch (e) { /* skip this currency, try the rest */ }
    }
    return all.sort((a, b) => a.native.localeCompare(b.native));
  }

  if (priceSource === "hyperliquid" || priceSource === "hyperliquid_spot") {
    const isSpot = priceSource === "hyperliquid_spot";
    const host = hyperliquidTestnet ? "api.hyperliquid-testnet.xyz" : "api.hyperliquid.xyz";
    const j = await fetchJson(`https://${host}/info`, { type: isSpot ? "spotMeta" : "meta" });
    const all = [];
    if (isSpot && j.tokens && j.universe) {
      for (const u of j.universe) {
        const base = j.tokens[u.tokens[0]]?.name, quote = j.tokens[u.tokens[1]]?.name;
        if (base && quote) all.push({ ccxt: `${base}/${quote}`, native: u.name });
      }
    } else if (!isSpot && j.universe) {
      for (const u of j.universe) {
        if (u.isDelisted) continue;
        all.push({ ccxt: `${u.name}/USDC:USDC`, native: `${u.name}-PERP` });
      }
    }
    return all.sort((a, b) => a.native.localeCompare(b.native));
  }

  // Default: binance_spot
  const data = await fetchJson("https://api.binance.com/api/v3/exchangeInfo");
  return data.symbols
    .filter((s) => s.status === "TRADING")
    .map((s) => ({ ccxt: `${s.baseAsset}/${s.quoteAsset}`, native: s.symbol }))
    .sort((a, b) => a.native.localeCompare(b.native));
}

async function fetchJson(url, body) {
  const r = await fetch(url, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function priceSourceToExchangeKey(priceSource) {
  if (priceSource.startsWith("binance")) return "binance";
  if (priceSource.startsWith("deribit")) return "deribit";
  return "hyperliquid";
}

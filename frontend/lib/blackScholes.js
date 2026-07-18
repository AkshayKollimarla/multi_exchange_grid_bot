// Ported 1:1 from index.html — shared by Add Strategy / Combined Simulator /
// Options Analysis's payoff chart (only Options Analysis is built so far).

// Standard normal CDF (Abramowitz-Stegun 7.1.26).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

// Black-Scholes price in USD terms. type "call"|"put", T in years.
export function bsPrice(type, S, K, T, sigma, r) {
  if (!(S > 0) || !(K > 0)) return 0;
  if (T <= 0 || sigma <= 0) return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  const st = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / st;
  const d2 = d1 - st;
  if (type === "call") return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

export function strikeNumber(strike) {
  if (!strike) return 0.0;
  const m = String(strike).replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0.0;
}

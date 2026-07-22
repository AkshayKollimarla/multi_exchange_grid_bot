// API base defaults to "" (relative) — once deployed, this static export is
// served by the SAME server.js/origin as the API, so relative /api/... paths
// just work and the existing session-cookie auth applies unchanged.
// NEXT_PUBLIC_API_BASE can point at a different origin for local dev only.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

async function request(path, opts) {
  const r = await fetch(`${API_BASE}${path}`, { credentials: "include", ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export function apiGet(path) {
  return request(path);
}

export function apiPost(path, body) {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function apiPut(path, body) {
  return request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function apiPatch(path, body) {
  return request(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function apiDelete(path) {
  return request(path, { method: "DELETE" });
}

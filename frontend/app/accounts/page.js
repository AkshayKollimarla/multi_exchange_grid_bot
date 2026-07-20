"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost, apiDelete } from "@/lib/api";

const EXCHANGES = [
  { value: "hyperliquid", label: "🟣 Hyperliquid" },
  { value: "binance", label: "🟦 Binance" },
  { value: "deribit", label: "🟧 Deribit" },
];
const ICON = { hyperliquid: "🟣", binance: "🟦", deribit: "🟧" };

const CRED_FIELDS = {
  hyperliquid: [
    { key: "walletAddress", label: "Wallet Address (public)", placeholder: "0x...", type: "text" },
    { key: "privateKey", label: "API Wallet Private Key", placeholder: "0x...", type: "password" },
  ],
  binance: [
    { key: "apiKey", label: "API Key", placeholder: "API key", type: "text" },
    { key: "secretKey", label: "Secret Key", placeholder: "Secret key", type: "password" },
  ],
  deribit: [
    { key: "clientId", label: "Client ID", placeholder: "Client ID", type: "text" },
    { key: "clientSecret", label: "Client Secret", placeholder: "Client secret", type: "password" },
  ],
};

const CRED_NOTE = {
  hyperliquid: "🔐 Use the API wallet private key — it can place orders but cannot withdraw.",
  binance: "🔐 Create an API key with trade permission (not withdrawal).",
  deribit: "🔐 A Deribit API client with trade scope.",
};

export default function AccountsPage() {
  const [accounts, setAccounts] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [exchange, setExchange] = useState("hyperliquid");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [testing, setTesting] = useState({});
  const [testResult, setTestResult] = useState({});

  const load = () => {
    apiGet("/api/accounts")
      .then((list) => { setAccounts(Array.isArray(list) ? list : []); setLoadError(null); })
      .catch((e) => setLoadError(e.message));
  };
  useEffect(load, []);

  function setCred(key, value) { setCreds((c) => ({ ...c, [key]: value })); }

  async function handleAdd() {
    const fields = CRED_FIELDS[exchange];
    const credentials = Object.fromEntries(fields.map((f) => [f.key, (creds[f.key] || "").trim()]));
    if (!name.trim() || Object.values(credentials).some((v) => !v)) {
      setMsg({ ok: false, text: "All fields are required." });
      return;
    }
    setSaving(true);
    setMsg({ ok: null, text: "Saving…" });
    try {
      await apiPost("/api/accounts", { name: name.trim(), exchange, credentials });
      setMsg({ ok: true, text: "✓ Account saved." });
      setName(""); setCreds({});
      load();
    } catch (e) {
      setMsg({ ok: false, text: "Failed: " + e.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestAuth(id) {
    setTesting((t) => ({ ...t, [id]: true }));
    setTestResult((r) => ({ ...r, [id]: null }));
    try {
      const r = await apiPost(`/api/accounts/${id}/test-auth`, {});
      setTestResult((res) => ({ ...res, [id]: r }));
    } catch (e) {
      setTestResult((res) => ({ ...res, [id]: { ok: false, error: e.message } }));
    } finally {
      setTesting((t) => ({ ...t, [id]: false }));
    }
  }

  async function handleDelete(id) {
    if (!confirm("Delete this account?")) return;
    try {
      await apiDelete(`/api/accounts/${id}`);
      load();
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  }

  return (
    <>
      <div className="header"><div className="header-logo">Grid<span>Bot</span> — Multi-Exchange</div></div>
      <section className="section">
        <div className="sec-head">👤 Accounts</div>
        <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 20, alignItems: "start" }}>
          <div className="card">
            <div className="card-header">➕ Add Account</div>
            <div className="card-body">
              <div className="field">
                <label>Exchange</label>
                <select value={exchange} onChange={(e) => { setExchange(e.target.value); setCreds({}); }}>
                  {EXCHANGES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                </select>
              </div>
              <div className="field"><label>Account Name</label><input type="text" placeholder="e.g. Hype Main" value={name} onChange={(e) => setName(e.target.value)} /></div>

              <div className="note">{CRED_NOTE[exchange]}</div>
              {CRED_FIELDS[exchange].map((f) => (
                <div className="field" key={f.key}>
                  <label>{f.label}</label>
                  <input type={f.type} placeholder={f.placeholder} value={creds[f.key] || ""} onChange={(e) => setCred(f.key, e.target.value)} autoComplete={f.type === "password" ? "new-password" : "off"} />
                </div>
              ))}

              <div className="btn-row" style={{ gridTemplateColumns: "1fr" }}>
                <button className="btn btn-start" onClick={handleAdd} disabled={saving}>＋ Add Account</button>
              </div>
              {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok === false ? "var(--red)" : msg.ok ? "var(--green)" : "var(--muted)" }}>{msg.text}</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-header-row">
                <span>🟣 Saved Accounts</span>
                <button className="btn-refresh" onClick={load}>↻ Refresh</button>
              </div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="ord-table">
                <thead><tr><th>Name</th><th>Exchange</th><th>Wallet</th><th></th></tr></thead>
                <tbody>
                  {loadError && <tr><td colSpan={4} className="empty-td">Could not load accounts: {loadError}</td></tr>}
                  {!loadError && accounts && accounts.length === 0 && <tr><td colSpan={4} className="empty-td">No accounts yet — add one on the left</td></tr>}
                  {!loadError && accounts && accounts.map((a) => {
                    const idv = a.identifier || a.walletAddress || "";
                    const masked = idv.length > 14 ? `${idv.slice(0, 6)}…${idv.slice(-4)}` : idv;
                    const result = testResult[a.id];
                    return (
                      <tr key={a.id}>
                        <td><b>{a.name}</b></td>
                        <td>{ICON[a.exchange] || ""} {a.exchange || "hyperliquid"}</td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{masked}</td>
                        <td>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
                            {a.exchange === "deribit" && (
                              <button className="btn-refresh" onClick={() => handleTestAuth(a.id)} disabled={testing[a.id]}>
                                {testing[a.id] ? "Testing…" : "🔌 Test Connection"}
                              </button>
                            )}
                            <button className="btn-refresh" style={{ color: "var(--red)" }} onClick={() => handleDelete(a.id)}>✕ Delete</button>
                          </div>
                          {result && (
                            <div style={{ fontSize: 11, marginTop: 4, textAlign: "right", color: result.ok ? "var(--green)" : "var(--red)" }}>
                              {result.ok ? `✓ ${result.message}${result.scope ? ` (${result.scope})` : ""}` : `✕ ${result.error}`}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

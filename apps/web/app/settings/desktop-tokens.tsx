"use client";

import { useState } from "react";

interface TokenRow {
  id: string;
  label: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function DesktopTokens({ initialTokens }: { initialTokens: TokenRow[] }) {
  const [tokens, setTokens] = useState(initialTokens.filter((token) => !token.revokedAt));
  const [label, setLabel] = useState("Desktop");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConnect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/desktop-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!response.ok) throw new Error("request failed");

      const { token, raw } = (await response.json()) as { token: TokenRow; raw: string };
      setTokens((prev) => [...prev, token]);
      setRevealed(raw);
    } catch {
      setError("Couldn't create a token — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    setError(null);
    const snapshot = tokens;
    setTokens((prev) => prev.filter((token) => token.id !== id));
    try {
      const response = await fetch(`/api/desktop-tokens/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("request failed");
    } catch {
      setTokens(snapshot);
      setError("Couldn't revoke that token — try again.");
    }
  }

  return (
    <div>
      {error && <p className="now-error">{error}</p>}

      <ul className="token-list">
        {tokens.map((token) => (
          <li key={token.id} className="token-row">
            <span>
              {token.label}
              <span className="token-meta">
                {" "}
                · created {new Date(token.createdAt).toLocaleDateString()}
                {token.lastUsedAt ? ` · last used ${new Date(token.lastUsedAt).toLocaleString()}` : " · never used"}
              </span>
            </span>
            <button type="button" className="btn btn-danger" onClick={() => handleRevoke(token.id)}>
              Revoke
            </button>
          </li>
        ))}
        {tokens.length === 0 && <p className="empty-state">No desktop connected yet.</p>}
      </ul>

      <div className="task-card-row">
        <input
          className="chat-input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label (e.g. this laptop)"
        />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={handleConnect}>
          Connect this desktop
        </button>
      </div>

      {revealed && (
        <>
          <div className="token-reveal">{revealed}</div>
          <p className="token-warning">
            Copy this now — it won&apos;t be shown again. Paste it into <code>persona-connect</code> on
            this machine.
          </p>
        </>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Connection } from "../types/connection.js";

interface AddConnectionModalProps {
  /** Pre-filled from a deep link (autonomos://connect?...). When set, the
   *  modal shows the source-of-pre-fill hint but still requires explicit
   *  user click to save — never auto-submits. */
  prefill?: { url: string; token: string; name?: string };
  onClose: () => void;
  onAdded: (c: Connection) => void;
}

/** Returns true when the URL is HTTP and points to a non-loopback host —
 *  worth surfacing as a warning since the token would travel in plaintext. */
function isPublicPlaintext(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    const host = u.hostname;
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.startsWith("172.")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function AddConnectionModal({
  prefill,
  onClose,
  onAdded,
}: AddConnectionModalProps): React.ReactElement {
  const [url, setUrl] = useState(prefill?.url ?? "");
  const [token, setToken] = useState(prefill?.token ?? "");
  const [name, setName] = useState(prefill?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Esc closes; focus URL input on open (only for non-prefilled — prefilled
  // dialogs deliberately don't auto-focus to discourage immediate Enter).
  useEffect(() => {
    if (!prefill) urlInputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefill, onClose, busy]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const trimmedName = name.trim();
    const result = await window.autonomos.connections.add({
      url: url.trim(),
      token: token.trim(),
      ...(trimmedName ? { name: trimmedName } : {}),
    });
    setBusy(false);
    if (result.ok) {
      onAdded(result.connection);
    } else {
      setError(result.message);
    }
  };

  const plaintextWarn = isPublicPlaintext(url);

  return (
    <div className="modal-backdrop">
      <button
        type="button"
        className="modal-close-overlay"
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
      />
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <h2 id="modal-title">Connect to autonomOS Server</h2>
        {prefill && (
          <div className="hint">
            Pre-filled from a deep link. Deep links should come from your
            terminal after running <code>install.sh</code>. If a webpage opened
            this dialog, close it and report the page.
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="url">URL</label>
            <input
              id="url"
              ref={urlInputRef}
              type="url"
              placeholder="https://forge.example.com:7421"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
          {plaintextWarn && (
            <div className="warning">
              This is an unencrypted HTTP connection over the public internet.
              The token will travel in plaintext. Only proceed if you trust the
              network.
            </div>
          )}
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="token">Token</label>
            <input
              id="token"
              type="password"
              placeholder="64-character bearer token from install.sh"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="name">Name (optional)</label>
            <input
              id="name"
              type="text"
              placeholder="forge"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && (
            <div className="error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
          <div className="actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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

/** A copyable inline CLI block. Click → clipboard. */
function CliBlock({
  command,
  out,
}: {
  command: string;
  out?: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No-op if clipboard blocked.
    }
  };
  return (
    <div className="cli-block">
      <button
        type="button"
        className="cli-block-copy"
        onClick={onCopy}
        title="Copy to clipboard"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <div className="cli-block-cmd">
        <span className="cli-block-prompt">$</span> {command}
      </div>
      {out && <div className="cli-block-out">→ {out}</div>}
    </div>
  );
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
  const [tokenVisible, setTokenVisible] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

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
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <h2 id="modal-title">Add a server</h2>
        <p className="hint">
          Connect autonomOS Desktop to a server you control. Run the commands
          below on the machine where you want the server to live, then paste the
          URL and token here.
        </p>

        {prefill && (
          <div className="hint" style={{ marginTop: 8 }}>
            <strong>Pre-filled from a deep link.</strong> Deep links should come
            from your terminal after pairing. If a webpage opened this dialog,
            close it and report the page.
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Step 1 — install the CLI */}
          <div className="step">
            <span className="step-num">1</span>
            <span className="step-text">
              Install the autonomos CLI (skip if already installed):
            </span>
          </div>
          <CliBlock command="brew install autonomos" />

          {/* Step 2 — start the server and grab its URL + token */}
          <div className="step">
            <span className="step-num">2</span>
            <span className="step-text">
              Start the server and get its URL + token:
            </span>
          </div>
          <CliBlock
            command="autonomos serve --print-url"
            out="http://yourhost:3100   token: abc123…"
          />

          {/* Step 3 — paste URL + token + name */}
          <div className="step" style={{ marginTop: 6 }}>
            <span className="step-num">3</span>
            <span className="step-text">Paste them here:</span>
          </div>

          <div className="field">
            <label htmlFor="url">URL</label>
            <input
              id="url"
              ref={urlInputRef}
              type="text"
              placeholder="https://forge.example.com:7421  or  localhost:3100"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
            />
            <span className="hint">
              http:// is added automatically if omitted. localhost works.
            </span>
          </div>

          {plaintextWarn && (
            <div className="warning">
              This is an unencrypted HTTP connection over the public internet.
              The token will travel in plaintext. Only proceed if you trust the
              network.
            </div>
          )}

          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="token">
              Token
              <button
                type="button"
                className="token-toggle"
                onClick={() => setTokenVisible((v) => !v)}
                aria-label={tokenVisible ? "Hide token" : "Show token"}
              >
                {tokenVisible ? "Hide" : "Show"}
              </button>
            </label>
            <input
              id="token"
              type={tokenVisible ? "text" : "password"}
              placeholder="64-character bearer token from the command above"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
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
              {busy ? "Connecting…" : "Add server"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

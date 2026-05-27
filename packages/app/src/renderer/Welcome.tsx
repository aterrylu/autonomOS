import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";

interface WelcomeProps {
  /** Pick the detected daemon / spawn a Built-in if none. */
  onPickLocal: () => void;
  /** User wants Built-in even though Always-on is running.
   *  Caller must confirm + migrate. */
  onPickBuiltInSwitch: () => void;
  onPickRemote: (id: string) => void;
  onAddRemote: () => void;
}

type DetectResult =
  | { running: true; port: number; pid: number; version: string }
  | { running: false };

export function Welcome({
  onPickLocal,
  onPickBuiltInSwitch,
  onPickRemote,
  onAddRemote,
}: WelcomeProps): React.ReactElement {
  const [remotes, setRemotes] = useState<Connection[]>([]);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [list, det] = await Promise.all([
        window.autonomos.connections.list(),
        window.autonomos.localServer.detect(),
      ]);
      // Belt-and-suspenders: migration also de-dupes localhost remotes,
      // but if any survive (e.g. user added one between launches), hide
      // them here too — they're functionally identical to "This Mac."
      setRemotes(
        list.filter((c) => {
          if (c.type !== "remote") return false;
          try {
            const host = new URL(c.url).hostname.toLowerCase();
            if (
              host === "localhost" ||
              host === "127.0.0.1" ||
              host === "::1" ||
              host === "0.0.0.0"
            ) {
              return false;
            }
          } catch {
            // Malformed URL → keep, user can see + fix it.
          }
          return true;
        }),
      );
      setDetected(det);
    })();
  }, []);

  const isDetected = detected?.running === true;

  // Primary local card — the recommended path. When Always-on is detected,
  // it gets the indigo "active" glow and shows the daemon's metadata.
  const primaryLocalCard = isDetected ? (
    <button
      type="button"
      className="welcome-card welcome-card-local welcome-card-active"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        onPickLocal();
      }}
      disabled={busy}
    >
      <div className="welcome-card-badge welcome-badge-on">Always-on</div>
      <h2>This Mac</h2>
      <p>
        Detected daemon
        <br />
        port {detected.port} · v{detected.version}
      </p>
    </button>
  ) : (
    <button
      type="button"
      className="welcome-card welcome-card-local welcome-card-active"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        onPickLocal();
      }}
      disabled={busy}
    >
      <div className="welcome-card-badge welcome-badge-built-in">Built-in</div>
      <h2>Built-in app server</h2>
      <p>
        Run agents inside autonomOS Desktop.
        <br />
        Agents pause when you close the app.
      </p>
    </button>
  );

  // Secondary "Switch to Built-in" card. Only shown when Always-on is
  // running — gives the power user a way to opt out of persistence.
  // Clicking opens a confirmation in WelcomeWindow (caller).
  const switchToBuiltInCard = isDetected ? (
    <button
      type="button"
      className="welcome-card"
      onClick={() => {
        if (busy) return;
        onPickBuiltInSwitch();
      }}
      disabled={busy}
    >
      <div className="welcome-card-badge welcome-badge-built-in">Built-in</div>
      <h2>Built-in app server</h2>
      <p>
        Switch from Always-on.
        <br />
        Agents will pause when you close the app.
      </p>
    </button>
  ) : null;

  return (
    <div className="welcome">
      <div className="welcome-mark">a</div>
      <h1>Welcome to autonomOS</h1>
      <p className="tagline">Choose a server to get started</p>

      <div className="welcome-cards">
        {primaryLocalCard}
        {switchToBuiltInCard}

        {remotes.map((r) => (
          <button
            key={r.id}
            type="button"
            className="welcome-card"
            onClick={() => {
              if (busy) return;
              setBusy(true);
              onPickRemote(r.id);
            }}
            disabled={busy}
          >
            <div className="welcome-card-badge welcome-badge-remote">
              Remote
            </div>
            <h2>{r.name}</h2>
            <p>{r.url}</p>
          </button>
        ))}

        <button
          type="button"
          className="welcome-card welcome-card-add"
          onClick={() => {
            if (busy) return;
            onAddRemote();
          }}
          disabled={busy}
        >
          <div className="welcome-card-badge">＋</div>
          <h2>Add a server</h2>
          <p>Connect to a local or remote autonomos instance</p>
        </button>
      </div>

      <p className="welcome-footer">
        Don&apos;t have a server yet? Run on any Mac or Linux box:
        <br />
        <code>
          curl -fsSL
          https://raw.githubusercontent.com/aterrylu/autonomOS/main/scripts/install.sh
          | sh
        </code>
      </p>
    </div>
  );
}

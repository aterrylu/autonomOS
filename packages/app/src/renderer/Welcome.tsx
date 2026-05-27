import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";

interface WelcomeProps {
  onPickLocal: () => void;
  onPickRemote: (id: string) => void;
  onAddRemote: () => void;
}

type DetectResult =
  | { running: true; port: number; pid: number; version: string }
  | { running: false };

/** Welcome screen — shown every launch (per UX decision: never auto-
 *  connect). Lists detected local daemon, saved remote connections,
 *  and actions to add a remote or run Built-in. */
export function Welcome({
  onPickLocal,
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
      setRemotes(list.filter((c) => c.type === "remote"));
      setDetected(det);
    })();
  }, []);

  const localCard = detected?.running ? (
    <button
      type="button"
      className="welcome-card welcome-card-local"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        onPickLocal();
      }}
      disabled={busy}
    >
      <div className="welcome-card-badge welcome-badge-on">● Always-on</div>
      <h2>This Mac</h2>
      <p>
        Detected running daemon
        <br />
        port {detected.port} · v{detected.version}
      </p>
    </button>
  ) : (
    <button
      type="button"
      className="welcome-card welcome-card-local"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        onPickLocal();
      }}
      disabled={busy}
    >
      <div className="welcome-card-badge welcome-badge-built-in">
        ○ Built-in
      </div>
      <h2>This Mac</h2>
      <p>
        Run autonomOS Server inside this app.
        <br />
        Agents pause when you close the app.
      </p>
    </button>
  );

  return (
    <div className="welcome">
      <div className="welcome-mark">a</div>
      <h1>Welcome to autonomOS</h1>
      <p className="tagline">Pick a server to connect to</p>

      <div className="welcome-cards">
        {localCard}

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
              ▷ Remote
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
          <h2>Add server</h2>
          <p>Paste URL + token from `install.sh` output</p>
        </button>
      </div>

      <p className="welcome-footer">
        Don&apos;t have a server yet? Run on any Mac or Linux box:
        <br />
        <code>curl -fsSL https://autonomos.cloud/install.sh | sh</code>
      </p>
    </div>
  );
}

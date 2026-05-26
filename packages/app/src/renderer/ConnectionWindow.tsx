import { useCallback, useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";
import { ConnectionWebview } from "./ConnectionWebview.js";
import { SettingsPanel } from "./SettingsPanel.js";

interface ConnectionWindowProps {
  connectionId: string;
}

/** Renderer for a BrowserWindow that owns one connection.
 *
 *  The "local" connection id is synthesized at runtime from the active
 *  server-supervisor; all other ids look up in the stored connections list. */
export function ConnectionWindow({
  connectionId,
}: ConnectionWindowProps): React.ReactElement {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [missing, setMissing] = useState(false);
  const [localFailed, setLocalFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<"built-in" | "always-on" | null>(null);

  const loadLocal = useCallback(async (): Promise<void> => {
    setLocalFailed(false);
    const info = await window.autonomos.localServer.info();
    if (!info) {
      setLocalFailed(true);
      return;
    }
    setMode(info.mode);
    setConnection({
      id: "local",
      name: "This Mac",
      type: "local",
      url: `http://127.0.0.1:${info.port}`,
    });
  }, []);

  useEffect(() => {
    (async () => {
      if (connectionId === "local") {
        await loadLocal();
        return;
      }
      const list = await window.autonomos.connections.list();
      const found = list.find((c) => c.id === connectionId);
      if (found) setConnection(found);
      else setMissing(true);
    })();
  }, [connectionId, loadLocal]);

  // Keyboard shortcut for settings (⌘,) on the local connection window.
  useEffect(() => {
    if (connectionId !== "local") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connectionId]);

  // Local-server startup failed. Common causes: no `node` binary on the
  // .app's launchd-inherited PATH, port collision with an older daemon,
  // bundled server missing from Resources/. Give the user a useful screen.
  if (localFailed && connectionId === "local") {
    return (
      <div className="full-bleed-message">
        <div style={{ maxWidth: 480 }}>
          <p style={{ color: "var(--text-bright)", fontSize: 15 }}>
            autonomOS Server couldn&apos;t start
          </p>
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: 12,
              marginTop: 12,
              textAlign: "left",
            }}
          >
            The Desktop tried to start the Built-in server but failed. Common
            causes:
          </p>
          <ul
            style={{
              color: "var(--text-muted)",
              fontSize: 12,
              textAlign: "left",
              paddingLeft: 18,
              marginTop: 4,
            }}
          >
            <li>
              Node.js isn&apos;t in this app&apos;s PATH (install Node 22+ from
              nodejs.org)
            </li>
            <li>Another version of autonomOS is using port 3100</li>
            <li>The bundled server is missing or corrupted</li>
          </ul>
          <div
            style={{
              marginTop: 20,
              display: "flex",
              gap: 8,
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              className="primary"
              onClick={() => loadLocal()}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => window.autonomos.windows.closeSelf()}
            >
              Close window
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (missing) {
    return (
      <div className="full-bleed-message">
        <div>
          <p>This connection no longer exists.</p>
          <button
            type="button"
            className="primary"
            onClick={() => window.autonomos.windows.closeSelf()}
          >
            Close window
          </button>
        </div>
      </div>
    );
  }

  if (!connection) {
    return <div className="full-bleed-message">Loading connection…</div>;
  }

  return (
    <>
      <ConnectionWebview connection={connection} />
      {connectionId === "local" && (
        <button
          type="button"
          className="settings-fab"
          onClick={() => setSettingsOpen(true)}
          title={
            mode === "always-on"
              ? "This Mac · Always-on (⌘,)"
              : "This Mac · Built-in (⌘,)"
          }
          aria-label="Settings"
        >
          ⚙
        </button>
      )}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

import { useEffect, useState } from "react";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<"built-in" | "always-on" | null>(null);

  useEffect(() => {
    (async () => {
      if (connectionId === "local") {
        // Synthesize the local connection from the active server.
        const info = await window.autonomos.localServer.info();
        if (!info) {
          setMissing(true);
          return;
        }
        setMode(info.mode);
        setConnection({
          id: "local",
          name: "This Mac",
          type: "local",
          url: `http://127.0.0.1:${info.port}`,
        });
        return;
      }
      const list = await window.autonomos.connections.list();
      const found = list.find((c) => c.id === connectionId);
      if (found) setConnection(found);
      else setMissing(true);
    })();
  }, [connectionId]);

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

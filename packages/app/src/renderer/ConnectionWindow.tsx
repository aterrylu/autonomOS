import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";
import { ConnectionWebview } from "./ConnectionWebview.js";
import { TitleBar } from "./TitleBar.js";

interface ConnectionWindowProps {
  connectionId: string;
}

/** Renderer for a BrowserWindow that owns one connection.
 *
 *  Layout:
 *    <TitleBar/>           ← host-side, draggable (entire bar moves window)
 *    <ConnectionWebview/>  ← dashboard loaded in <webview>
 *
 *  The dashboard's OWN <Header> is hidden via CSS injection in
 *  ConnectionWebview, because <webview> guest content cannot be made
 *  window-draggable (Electron isolates it). The host title bar above
 *  carries the "autonomOS" branding + connection name and provides the
 *  drag handle. */
export function ConnectionWindow({
  connectionId,
}: ConnectionWindowProps): React.ReactElement {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    (async () => {
      const list = await window.autonomos.connections.list();
      const found = list.find((c) => c.id === connectionId);
      if (found) setConnection(found);
      else setMissing(true);
    })();
  }, [connectionId]);

  if (missing) {
    return (
      <>
        <TitleBar label="autonomOS" />
        <div className="view">
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
        </div>
      </>
    );
  }

  if (!connection) {
    return (
      <>
        <TitleBar label="autonomOS" />
        <div className="view">
          <div className="full-bleed-message">Loading connection…</div>
        </div>
      </>
    );
  }

  return (
    <>
      <TitleBar label={`autonomOS · ${connection.name}`} />
      <div className="view">
        <ConnectionWebview connection={connection} />
      </div>
    </>
  );
}

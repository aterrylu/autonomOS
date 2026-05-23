import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";
import { ConnectionWebview } from "./ConnectionWebview.js";

interface ConnectionWindowProps {
  connectionId: string;
}

/** Renderer for a BrowserWindow that owns one connection. No host-side
 *  title bar — the webview fills the entire window, and CSS injection
 *  in ConnectionWebview makes the dashboard's own <Header> the drag
 *  region. */
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

  return <ConnectionWebview connection={connection} />;
}

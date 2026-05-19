import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";
import { AddConnectionModal } from "./AddConnectionModal.js";
import { Welcome } from "./Welcome.js";

type View =
  | { kind: "loading" }
  | { kind: "welcome" }
  | { kind: "connected"; connection: Connection };

export function App(): React.ReactElement {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [modalOpen, setModalOpen] = useState(false);
  const [modalPrefill, setModalPrefill] = useState<
    { url: string; token: string; name?: string } | undefined
  >(undefined);

  // Load initial state from main process.
  useEffect(() => {
    (async () => {
      const defaultId = await window.autonomos.connections.getDefault();
      const list = await window.autonomos.connections.list();
      const active = defaultId
        ? list.find((c) => c.id === defaultId)
        : undefined;
      if (active) setView({ kind: "connected", connection: active });
      else setView({ kind: "welcome" });
    })();
  }, []);

  const handleConnectionAdded = (connection: Connection): void => {
    setView({ kind: "connected", connection });
    void window.autonomos.connections.setDefault(connection.id);
  };

  if (view.kind === "loading") {
    return <div className="connected">Loading…</div>;
  }

  if (view.kind === "welcome") {
    return (
      <>
        <Welcome
          onConnectRemote={() => {
            setModalPrefill(undefined);
            setModalOpen(true);
          }}
          onSetupLocal={() => {
            // 1B.2.5 wires the actual install flow.
            alert("Set up local server is shipping in Phase 1B.2.5.");
          }}
        />
        {modalOpen && (
          <AddConnectionModal
            prefill={modalPrefill}
            onClose={() => setModalOpen(false)}
            onAdded={(c) => {
              setModalOpen(false);
              handleConnectionAdded(c);
            }}
          />
        )}
      </>
    );
  }

  // view.kind === "connected"
  return (
    <div className="connected">
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <p style={{ color: "#f1f5f9", fontSize: 16, margin: 0 }}>
          Connected to <strong>{view.connection.name}</strong>
        </p>
        <p style={{ marginTop: 8, color: "#64748b", fontSize: 12 }}>
          <code>{view.connection.url}</code>
        </p>
        <p style={{ marginTop: 24, color: "#64748b", fontSize: 12 }}>
          The webview that loads this connection&apos;s dashboard ships in Phase
          1B.2.3. For now you can verify the connection record persists across
          app restarts.
        </p>
      </div>
    </div>
  );
}

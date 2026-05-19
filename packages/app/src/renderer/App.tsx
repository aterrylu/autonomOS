import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";
import { AddConnectionModal } from "./AddConnectionModal.js";
import { ConnectionWebview } from "./ConnectionWebview.js";
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
  return <ConnectionWebview connection={view.connection} />;
}

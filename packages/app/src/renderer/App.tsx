import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";
import { AddConnectionModal } from "./AddConnectionModal.js";
import { ConnectionWebview } from "./ConnectionWebview.js";
import { TitleBar } from "./TitleBar.js";
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

  const handleDisconnect = (): void => {
    setView({ kind: "welcome" });
    void window.autonomos.connections.setDefault(null);
  };

  const titleLabel =
    view.kind === "connected" ? view.connection.name : "autonomOS";

  const titleActions =
    view.kind === "connected" ? (
      <button type="button" onClick={handleDisconnect}>
        Disconnect
      </button>
    ) : null;

  return (
    <>
      <TitleBar label={titleLabel}>{titleActions}</TitleBar>
      <div className="view">
        {view.kind === "loading" && <div className="connected">Loading…</div>}
        {view.kind === "welcome" && (
          <Welcome
            onConnectRemote={() => {
              setModalPrefill(undefined);
              setModalOpen(true);
            }}
            onSetupLocal={() => {
              alert("Set up local server is shipping in Phase 1B.2.5.");
            }}
          />
        )}
        {view.kind === "connected" && (
          <ConnectionWebview connection={view.connection} />
        )}
      </div>
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

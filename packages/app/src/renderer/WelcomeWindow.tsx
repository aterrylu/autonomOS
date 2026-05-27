import { useState } from "react";
import type { Connection } from "../types/connection.js";
import { AddConnectionModal } from "./AddConnectionModal.js";
import { TitleBar } from "./TitleBar.js";
import { Welcome } from "./Welcome.js";

export function WelcomeWindow(): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);
  const [acquireError, setAcquireError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handlePickLocal = async (): Promise<void> => {
    setBusy(true);
    setAcquireError(null);
    const result = await window.autonomos.localServer.acquire();
    if (!result.ok) {
      setBusy(false);
      setAcquireError(result.message ?? "Server couldn't start.");
      return;
    }
    await window.autonomos.windows.openConnection("local");
    await window.autonomos.windows.closeSelf();
  };

  const handlePickRemote = async (id: string): Promise<void> => {
    setBusy(true);
    await window.autonomos.windows.openConnection(id);
    await window.autonomos.windows.closeSelf();
  };

  const handleAdded = async (c: Connection): Promise<void> => {
    setModalOpen(false);
    await window.autonomos.windows.openConnection(c.id);
    await window.autonomos.windows.closeSelf();
  };

  return (
    <>
      <TitleBar label="autonomOS" />
      <div className="view">
        <Welcome
          onPickLocal={() => void handlePickLocal()}
          onPickRemote={(id) => void handlePickRemote(id)}
          onAddRemote={() => setModalOpen(true)}
        />
        {acquireError && (
          <div className="welcome-error">
            <strong>autonomOS Server couldn&apos;t start:</strong>{" "}
            {acquireError}
          </div>
        )}
        {busy && !acquireError && (
          <div className="welcome-busy">Connecting…</div>
        )}
      </div>
      {modalOpen && (
        <AddConnectionModal
          onClose={() => setModalOpen(false)}
          onAdded={(c) => {
            void handleAdded(c);
          }}
        />
      )}
    </>
  );
}

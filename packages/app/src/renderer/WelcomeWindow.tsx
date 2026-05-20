import { useState } from "react";
import type { Connection } from "../types/connection.js";
import { AddConnectionModal } from "./AddConnectionModal.js";
import { TitleBar } from "./TitleBar.js";
import { Welcome } from "./Welcome.js";

/** Renderer for a connectionless (Welcome) BrowserWindow. Has a real
 *  title bar since there's no dashboard to integrate the traffic lights
 *  with. After the user adds a connection, the welcome window closes
 *  itself and the main process opens a new BrowserWindow for that
 *  connection. */
export function WelcomeWindow(): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);

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
          onConnectRemote={() => setModalOpen(true)}
          onSetupLocal={() => {
            alert("Set up local server is shipping in Phase 1B.2.5.");
          }}
        />
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

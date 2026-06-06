import { useState } from "react";
import type { Connection } from "../types/connection.js";
import { AddConnectionModal } from "./AddConnectionModal.js";
import { TitleBar } from "./TitleBar.js";
import { Welcome } from "./Welcome.js";

export function WelcomeWindow(): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);
  const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);
  const [acquireError, setAcquireError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState("Connecting…");

  const handlePickLocal = async (): Promise<void> => {
    setBusy(true);
    setBusyMessage("Connecting…");
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
    setBusyMessage("Opening…");
    await window.autonomos.windows.openConnection(id);
    await window.autonomos.windows.closeSelf();
  };

  const handlePickTryItOut = async (): Promise<void> => {
    setBusy(true);
    setBusyMessage("Starting try mode…");
    setAcquireError(null);
    const result = await window.autonomos.localServer.acquireEphemeral();
    if (!result.ok) {
      setBusy(false);
      setAcquireError(result.message ?? "Try mode couldn't start.");
      return;
    }
    await window.autonomos.windows.openConnection("local");
    await window.autonomos.windows.closeSelf();
  };

  const handleAdded = async (c: Connection): Promise<void> => {
    setModalOpen(false);
    setBusy(true);
    setBusyMessage("Opening…");
    await window.autonomos.windows.openConnection(c.id);
    await window.autonomos.windows.closeSelf();
  };

  const handleConfirmSwitch = async (): Promise<void> => {
    setSwitchConfirmOpen(false);
    setBusy(true);
    setBusyMessage("Switching to Built-in… uninstalling Always-on service");
    setAcquireError(null);

    // 1. Uninstall the LaunchAgent → server stops, pid file released
    const migrate = await window.autonomos.localServer.migrateToBuiltIn();
    if (!migrate.ok) {
      setBusy(false);
      setAcquireError(migrate.message);
      return;
    }

    // 2. Acquire (will spawn Built-in child since no daemon is running now)
    setBusyMessage("Starting Built-in server…");
    const acquire = await window.autonomos.localServer.acquire();
    if (!acquire.ok) {
      setBusy(false);
      setAcquireError(acquire.message ?? "Built-in server couldn't start.");
      return;
    }

    // 3. Open the local connection window
    await window.autonomos.windows.openConnection("local");
    await window.autonomos.windows.closeSelf();
  };

  return (
    <>
      <TitleBar label="autonomOS" />
      <div className="view">
        <Welcome
          onPickLocal={() => void handlePickLocal()}
          onPickBuiltInSwitch={() => setSwitchConfirmOpen(true)}
          onPickRemote={(id) => void handlePickRemote(id)}
          onAddRemote={() => setModalOpen(true)}
          onPickTryItOut={() => void handlePickTryItOut()}
        />
        {acquireError && (
          <div className="welcome-error">
            <strong>autonomOS Server couldn&apos;t start:</strong>{" "}
            {acquireError}
          </div>
        )}
        {busy && !acquireError && (
          <div className="welcome-busy">{busyMessage}</div>
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
      {switchConfirmOpen && (
        <div className="modal-backdrop">
          <button
            type="button"
            className="modal-close-overlay"
            aria-label="Close"
            onClick={() => setSwitchConfirmOpen(false)}
          />
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="switch-title"
          >
            <h2 id="switch-title">Switch to Built-in?</h2>
            <p className="hint" style={{ marginTop: 4 }}>
              This will uninstall the Always-on service. Going forward, agents
              will run only while autonomOS Desktop is open and pause when you
              close the app. <strong>Your data is preserved</strong> — sessions
              and configuration stay in <code>~/.autonomos/</code>.
            </p>
            <p
              className="hint"
              style={{ marginTop: 8, color: "var(--text-muted)" }}
            >
              You can switch back to Always-on anytime from Settings (⌘,).
            </p>
            <div className="actions">
              <button type="button" onClick={() => setSwitchConfirmOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void handleConfirmSwitch()}
              >
                Switch to Built-in
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

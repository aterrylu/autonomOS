import { useCallback, useEffect, useState } from "react";

interface SettingsPanelProps {
  onClose: () => void;
}

type ServerMode = "built-in" | "always-on" | "loading";

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const [mode, setMode] = useState<ServerMode>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const info = await window.autonomos.localServer.info();
    setMode(info?.mode ?? "built-in");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const result =
        mode === "built-in"
          ? await window.autonomos.localServer.migrateToAlwaysOn()
          : await window.autonomos.localServer.migrateToBuiltIn();
      setMessage(result.message);
      if (result.ok) {
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const isOn = mode === "always-on";

  return (
    <div className="modal-backdrop">
      <button
        type="button"
        className="modal-close-overlay"
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
      />
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <h2 id="settings-title">Settings</h2>

        <div className="setting-row">
          <div className="setting-info">
            <div className="setting-label">
              Keep autonomOS running in the background
            </div>
            <div className="setting-hint">
              {isOn
                ? "Agents will keep working even when you close this app."
                : "Agents pause when you close this app. They'll resume when you reopen it."}
            </div>
          </div>
          <button
            type="button"
            className={`toggle ${isOn ? "toggle-on" : "toggle-off"}`}
            onClick={handleToggle}
            disabled={busy || mode === "loading"}
            aria-pressed={isOn}
          >
            <span className="toggle-knob" />
          </button>
        </div>

        {message && (
          <div className="hint" style={{ marginTop: 12 }}>
            {message}
          </div>
        )}

        <div className="actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

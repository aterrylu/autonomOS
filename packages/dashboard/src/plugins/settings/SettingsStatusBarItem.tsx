import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Codicon, type CodiconName } from "../../components/Codicon";
import { PermissionModeSelect } from "../../components/PermissionModeSelect";
import { AgentStatusIcon } from "../../components/ui/agent-status-icon";
import { ProviderAgentIcon } from "../../components/ui/provider-icon";
import { type AgentIconStyle, THEMES, useStore } from "../../store";
import { useClickOutside } from "../claude-usage/useClickOutside";

interface MaskedSettings {
  claudeSessionKey: string | null;
  channels: string[];
  autoTrust: boolean;
  updateCheck: boolean;
  customEnvVars: Record<string, string>;
  statusLine: { enabled: boolean };
}

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

function ToggleSwitch({
  enabled,
  inactiveBackground,
  onClick,
  testId,
}: {
  enabled: boolean;
  inactiveBackground: string;
  onClick: () => void;
  /** Optional stable handle for e2e tests (durable vs a CSS-class xpath). */
  testId?: string;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: toggle switch
    // biome-ignore lint/a11y/noStaticElementInteractions: toggle switch
    <div
      className="relative w-8 h-4 rounded-full cursor-pointer transition-colors"
      style={{ background: enabled ? "#16825d" : inactiveBackground }}
      onClick={onClick}
      data-testid={testId}
    >
      <div
        className="absolute top-0.5 w-3 h-3 rounded-full transition-transform"
        style={{
          background: "#fff",
          left: enabled ? "18px" : "2px",
        }}
      />
    </div>
  );
}

type ChannelStatus = "ok" | "disabled" | "not-installed" | "unknown";

interface ChannelStatusEntry {
  id: string;
  label: string;
  icon: string;
  status: ChannelStatus;
  fix: string | null;
}

function channelStatusLabel(status: ChannelStatus): string | null {
  switch (status) {
    case "not-installed":
      return "Not installed";
    case "disabled":
      return "Disabled";
    case "unknown":
      return "Status unknown";
    default:
      return null;
  }
}

function ChannelToggle({
  label,
  icon,
  enabled,
  status,
  fix,
  page,
  onToggle,
}: {
  label: string;
  icon: CodiconName;
  enabled: boolean;
  status: ChannelStatus;
  fix: string | null;
  page: PageTheme;
  onToggle: () => void;
}) {
  // "unknown" (detection failed) stays interactive so a flaky subprocess
  // doesn't lock the user out of settings they already had configured.
  const lockedOff =
    !enabled && (status === "not-installed" || status === "disabled");
  const statusLabel = channelStatusLabel(status);

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={lockedOff ? undefined : onToggle}
        disabled={lockedOff}
        title={fix ?? undefined}
        className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-xs"
        style={{
          background: enabled ? "#16825d20" : page.border,
          border: enabled ? "1px solid #16825d50" : "1px solid transparent",
          color: page.fg,
          cursor: lockedOff ? "not-allowed" : "pointer",
          opacity: lockedOff ? 0.55 : 1,
        }}
      >
        <Codicon name={icon} size={14} />
        <span className="flex-1 text-left">{label}</span>
        <Codicon
          name={lockedOff ? "lock" : enabled ? "check" : "circle-large"}
          size={14}
          style={{ color: enabled ? "#16825d" : page.statusFg }}
        />
      </button>
      {statusLabel && (
        <div
          className="text-[10px] px-2"
          style={{
            color: status === "unknown" ? page.statusFg : "#ea6c73",
          }}
        >
          {statusLabel}
          {fix && (
            <>
              {" — run "}
              <code
                className="rounded px-1"
                style={{ background: page.border }}
              >
                {fix}
              </code>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EnvVarRow({
  envKey,
  value,
  inputStyle,
  page,
  onChange,
  onRemove,
}: {
  envKey: string;
  value: string;
  inputStyle: React.CSSProperties;
  page: PageTheme;
  onChange: (key: string, value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-1.5 items-center">
      <input
        type="text"
        value={envKey}
        onChange={(e) => onChange(e.target.value, value)}
        placeholder="KEY"
        className="flex-1 rounded px-2 py-1.5 text-xs font-mono min-w-0"
        style={inputStyle}
      />
      <span className="text-[10px]" style={{ color: page.statusFg }}>
        =
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(envKey, e.target.value)}
        placeholder="value"
        className="flex-1 rounded px-2 py-1.5 text-xs font-mono min-w-0"
        style={inputStyle}
      />
      <button
        type="button"
        onClick={onRemove}
        className="rounded p-1 cursor-pointer hover:opacity-80"
        style={{ color: page.statusFg }}
      >
        <Codicon name="close" size={12} />
      </button>
    </div>
  );
}

type EnvVarEntry = { id: number; key: string; value: string };

function EnvVarSection({
  settings,
  pendingEnvVars,
  setPendingEnvVars,
  envIdCounter,
  inputStyle,
  page,
  labelStyle,
}: {
  settings: MaskedSettings | null;
  pendingEnvVars: EnvVarEntry[] | null;
  setPendingEnvVars: (rows: EnvVarEntry[] | null) => void;
  envIdCounter: React.RefObject<number>;
  inputStyle: React.CSSProperties;
  page: PageTheme;
  labelStyle: React.CSSProperties;
}) {
  // Derive rows from pending state or server settings. Memoized so IDs are
  // stable across re-renders (prevents React from remounting inputs).
  // Once the user edits, pendingEnvVars takes over and this memo is bypassed.
  const settingsVars = settings?.customEnvVars;
  const serverRows = useMemo(() => {
    return Object.entries(settingsVars ?? {}).map(([k, v]) => ({
      id: envIdCounter.current++,
      key: k,
      value: v,
    }));
  }, [settingsVars, envIdCounter]);
  const rows = pendingEnvVars ?? serverRows;

  return (
    <>
      <div className="space-y-1.5">
        {rows.map((row, i) => (
          <EnvVarRow
            key={row.id}
            envKey={row.key}
            value={row.value}
            inputStyle={inputStyle}
            page={page}
            onChange={(newKey, newValue) => {
              const updated = [...rows];
              updated[i] = { ...updated[i], key: newKey, value: newValue };
              setPendingEnvVars(updated);
            }}
            onRemove={() => {
              setPendingEnvVars(rows.filter((_, j) => j !== i));
            }}
          />
        ))}
        <button
          type="button"
          onClick={() => {
            setPendingEnvVars([
              ...rows,
              { id: envIdCounter.current++, key: "", value: "" },
            ]);
          }}
          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-xs cursor-pointer hover:opacity-80"
          style={{ color: "#16825d" }}
        >
          <span className="text-sm leading-none">+</span>
          Add Variable
        </button>
      </div>
      <div className="text-[10px]" style={labelStyle}>
        Applied to all newly spawned sessions. Restart existing sessions to
        apply.
      </div>
    </>
  );
}

function RestartAllButton({ page }: { page: PageTheme }) {
  const [state, setState] = useState<
    "idle" | "confirming" | "restarting" | "done"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  const handleRestart = useCallback(async () => {
    setState("restarting");
    setError(null);
    try {
      const res = await fetch("/api/agents/restart-all", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { idMap, failures } = (await res.json()) as {
        idMap?: Record<string, string>;
        failures?: Array<{ id: string; name: string; error: string }>;
      };
      if (idMap && Object.keys(idMap).length > 0) {
        useStore.getState().remapSessionIds(idMap);
      }
      // Partial-success path: route returned 200 but some agents failed
      // to respawn. Surface them so the user can investigate (server logs
      // carry the full per-agent stack); without this the green "done"
      // state masks N agents that didn't come back.
      if (Array.isArray(failures) && failures.length > 0) {
        const names = failures.map((f) => f.name).join(", ");
        setError(`${failures.length} agent(s) failed to restart: ${names}`);
        setState("idle");
        return;
      }
      setState("done");
      setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restart failed");
      setState("idle");
    }
  }, []);

  if (state === "confirming") {
    return (
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleRestart}
          className="flex-1 rounded px-3 py-1.5 text-xs font-medium cursor-pointer"
          style={{ background: "#ea6c73", color: "#fff" }}
        >
          Confirm restart
        </button>
        <button
          type="button"
          onClick={() => setState("idle")}
          className="rounded px-3 py-1.5 text-xs cursor-pointer"
          style={{ background: page.border, color: page.fg }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div
          className="text-xs mb-1 rounded px-2 py-1"
          style={{ color: "#ea6c73" }}
        >
          {error}
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          setState("confirming");
          setError(null);
        }}
        disabled={state === "restarting" || state === "done"}
        className="w-full rounded px-3 py-1.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: page.border, color: page.fg }}
      >
        {restartButtonLabel(state)}
      </button>
    </div>
  );
}

function restartButtonLabel(state: string): string {
  if (state === "done") return "Sessions Restarted!";
  if (state === "restarting") return "Restarting Sessions...";
  return "Restart All Sessions";
}

function saveButtonLabel(saving: boolean, saved: boolean): string {
  if (saved) return "Saved!";
  if (saving) return "Saving...";
  return "Save";
}

const THEME_LABELS: Record<string, string> = {
  midnight: "Midnight",
  daylight: "Daylight",
  void: "Void",
};

/** Visual two-card picker for the agent-icon style. Each card renders a live
 *  preview of the actual icons so the choice is explicit, not just a label. */
function AgentIconStylePicker({ page }: { page: PageTheme }) {
  const style = useStore((s) => s.agentIconStyle);
  const setStyle = useStore((s) => s.setAgentIconStyle);

  const card = (
    value: AgentIconStyle,
    title: string,
    preview: React.ReactNode,
  ) => {
    const selected = style === value;
    return (
      <button
        type="button"
        onClick={() => setStyle(value)}
        data-testid={`agent-icon-style-${value}`}
        className="flex-1 flex flex-col items-center gap-1.5 rounded-md px-2 py-2 cursor-pointer transition-colors"
        style={{
          border: `2px solid ${selected ? "#16825d" : page.border}`,
          background: selected ? "#16825d22" : "transparent",
        }}
      >
        <div className="flex items-center gap-2.5 h-5">{preview}</div>
        <span className="text-[10px]" style={{ color: page.fg }}>
          {title}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs" style={{ color: page.statusFg }}>
        Agent Icons
      </span>
      <div className="flex gap-2">
        {card(
          "provider",
          "Provider + status",
          <>
            <ProviderAgentIcon provider="claude-code" status="idle" size={16} />
            <ProviderAgentIcon provider="codex" status="working" size={16} />
            <ProviderAgentIcon
              provider="gemini-cli"
              status="needs_input"
              size={16}
            />
          </>,
        )}
        {card(
          "status",
          "Status only",
          <>
            <AgentStatusIcon status="idle" size={14} />
            <AgentStatusIcon status="working" size={14} />
            <AgentStatusIcon status="needs_input" size={14} />
          </>,
        )}
      </div>
    </div>
  );
}

function DashboardPreferences({ page }: { page: PageTheme }) {
  const theme = useStore((s) => s.theme);
  const permissionMode = useStore((s) => s.permissionMode);
  const cycleTheme = useStore((s) => s.cycleTheme);
  const setPermissionMode = useStore((s) => s.setPermissionMode);

  const labelStyle: React.CSSProperties = { color: page.statusFg };

  return (
    <div className="space-y-2.5">
      <div
        className="text-[10px] font-medium uppercase tracking-wide"
        style={labelStyle}
      >
        Dashboard
      </div>

      {/* Theme */}
      <div className="flex items-center justify-between">
        <span className="text-xs" style={labelStyle}>
          Theme
        </span>
        <button
          type="button"
          onClick={cycleTheme}
          className="rounded px-2.5 py-1 text-xs cursor-pointer"
          style={{ background: page.border, color: page.fg }}
        >
          {THEME_LABELS[theme] ?? theme}
        </button>
      </div>

      {/* Permission mode — seeds the Create Agent form in THIS browser only.
          It is stored in localStorage, not on the server, so it does not apply
          to agents spawned by other agents (MCP create_agent) or by any other
          client. Saying so matters: read as a server-wide setting, it explains
          neither why an agent-spawned agent came up in a different mode nor why
          another browser disagrees. */}
      <div className="flex items-center justify-between">
        <span className="text-xs" style={labelStyle}>
          Permission Mode
        </span>
        <PermissionModeSelect
          value={permissionMode}
          onChange={setPermissionMode}
          page={page}
        />
      </div>
      <div className="text-[10px]" style={labelStyle}>
        Preselects tool-use autonomy in Create Agent, overridable per spawn.
        Saved in this browser only — it does not change how agents spawned by
        other agents start, which is <code>ask</code> unless their template or
        the spawn request says otherwise.
      </div>

      {/* Agent icon style */}
      <AgentIconStylePicker page={page} />
    </div>
  );
}

export function SettingsPanel({
  onClose,
  toggleRef,
}: {
  onClose: () => void;
  toggleRef?: React.RefObject<HTMLElement | null>;
}) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose, toggleRef);

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<MaskedSettings | null>(null);

  const [pending, setPending] = useState<Record<string, string>>({});
  const [pendingChannels, setPendingChannels] = useState<string[] | null>(null);
  const [pendingEnvVars, setPendingEnvVars] = useState<EnvVarEntry[] | null>(
    null,
  );
  const [channelStatuses, setChannelStatuses] = useState<
    ChannelStatusEntry[] | null
  >(null);
  const envIdCounter = useRef(0);

  const toggleSetting = useCallback(
    async (key: keyof MaskedSettings, newVal: unknown) => {
      try {
        const res = await fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [key]: newVal }),
        });
        if (res.ok) {
          const updated: MaskedSettings = await res.json();
          setSettings(updated);
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        } else {
          setError(`Toggle failed (HTTP ${res.status})`);
        }
      } catch {
        setError("Could not reach server");
      }
    },
    [],
  );

  const refreshChannelStatuses = useCallback(async () => {
    try {
      const r = await fetch("/api/channels/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: { channels: ChannelStatusEntry[] } = await r.json();
      setChannelStatuses(data.channels);
    } catch {
      // Leave channelStatuses null — the panel shows its loading
      // placeholder instead of a hard failure. A fetch error here means
      // the server itself is unreachable, not a flaky status check.
      setChannelStatuses(null);
    }
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: MaskedSettings) => {
        setSettings(data);
        setLoaded(true);
      })
      .catch((err) => {
        setError(
          `Failed to load: ${err instanceof Error ? err.message : "unknown"}`,
        );
        setLoaded(true);
      });

    refreshChannelStatuses();
  }, [refreshChannelStatuses]);

  async function handleSave() {
    const hasTextChanges = Object.keys(pending).length > 0;
    const hasChannelChanges = pendingChannels !== null;
    const hasEnvChanges = pendingEnvVars !== null;
    if (!hasTextChanges && !hasChannelChanges && !hasEnvChanges) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const body: Record<string, unknown> = { ...pending };
      if (pendingChannels !== null) {
        body.channels = pendingChannels;
      }
      if (pendingEnvVars !== null) {
        const vars: Record<string, string> = {};
        for (const { key, value } of pendingEnvVars) {
          const k = key.trim();
          if (k) vars[k] = value;
        }
        body.customEnvVars = vars;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Surface the actionable error message the server returns
        // (e.g. "Refusing to save channels that would silently no-op...").
        const data = await res.json().catch(() => null);
        setError(
          data && typeof data.error === "string"
            ? data.error
            : `Failed to save (HTTP ${res.status})`,
        );
        // Plugin state may have flipped since the panel opened — refresh
        // so the banner error lines up with what the toggles show.
        refreshChannelStatuses();
        return;
      }
      const updated: MaskedSettings = await res.json();
      setSettings(updated);
      setPending({});
      setPendingChannels(null);
      setPendingEnvVars(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
      setError("Could not reach server");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: page.border,
    color: page.fg,
    border: "none",
    outline: "none",
  };

  const labelStyle: React.CSSProperties = { color: page.statusFg };
  const hasPending =
    Object.keys(pending).length > 0 ||
    pendingChannels !== null ||
    pendingEnvVars !== null;

  return (
    <div
      ref={ref}
      // max-h + scroll: the panel grew past short viewports as toggles
      // accumulated (the Update Check toggle tipped it over in the e2e
      // viewport, leaving lower controls unreachable — clicks timed out
      // "outside of the viewport"). Cap to the space above the status bar
      // and scroll the overflow instead.
      className="absolute bottom-full left-0 mb-1 w-[340px] rounded-md p-3 text-xs shadow-lg max-h-[calc(100vh-4rem)] overflow-y-auto"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
        zIndex: 50,
      }}
    >
      <div className="font-medium text-sm mb-3">Settings</div>

      {/* Dashboard preferences — local state, no server round-trip */}
      <DashboardPreferences page={page} />

      <div className="my-3" style={{ borderTop: `1px solid ${page.border}` }} />

      {!loaded ? (
        <div style={labelStyle}>Loading...</div>
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div
              className="text-[10px] font-medium uppercase tracking-wide"
              style={labelStyle}
            >
              Auto-Trust
            </div>
            <ToggleSwitch
              enabled={!!settings?.autoTrust}
              inactiveBackground={page.border}
              onClick={() => toggleSetting("autoTrust", !settings?.autoTrust)}
              testId="auto-trust-toggle"
            />
          </div>
          <div className="text-[10px]" style={labelStyle}>
            Auto-dismiss workspace trust and dev channel prompts on session
            start.
          </div>

          <div className="flex items-center justify-between mt-3">
            <div
              className="text-[10px] font-medium uppercase tracking-wide"
              style={labelStyle}
            >
              Update Check
            </div>
            <ToggleSwitch
              // Default-on: only off when explicitly set to false.
              enabled={settings?.updateCheck !== false}
              inactiveBackground={page.border}
              onClick={() =>
                toggleSetting("updateCheck", settings?.updateCheck === false)
              }
              testId="update-check-toggle"
            />
          </div>
          <div className="text-[10px]" style={labelStyle}>
            Check GitHub daily for a newer release and show a passive badge in
            the status bar. The dashboard itself never contacts GitHub.
          </div>

          <div className="flex items-center justify-between mt-3">
            <div
              className="text-[10px] font-medium uppercase tracking-wide"
              style={labelStyle}
            >
              autonomOS Statusline
            </div>
            <ToggleSwitch
              // Default-on: only off when explicitly set to false.
              enabled={settings?.statusLine?.enabled !== false}
              inactiveBackground={page.border}
              onClick={() =>
                toggleSetting("statusLine", {
                  enabled: settings?.statusLine?.enabled === false,
                })
              }
            />
          </div>
          <div className="text-[10px]" style={labelStyle}>
            Show an autonomOS-aware statusline in spawned agents (replaces
            personal ~/.claude/settings.json statusLine for spawned sessions
            only). Applies to newly spawned agents.
          </div>

          <div
            className="text-[10px] font-medium uppercase tracking-wide mt-3"
            style={labelStyle}
          >
            Channels
          </div>
          <div className="space-y-1.5">
            {channelStatuses === null ? (
              <div className="text-[10px]" style={labelStyle}>
                Loading channels...
              </div>
            ) : (
              channelStatuses.map((ch) => {
                const current = pendingChannels ?? settings?.channels ?? [];
                const isEnabled = current.includes(ch.id);
                return (
                  <ChannelToggle
                    key={ch.id}
                    label={ch.label}
                    icon={ch.icon as CodiconName}
                    enabled={isEnabled}
                    status={ch.status}
                    fix={ch.fix}
                    page={page}
                    onToggle={() => {
                      setPendingChannels(
                        isEnabled
                          ? current.filter((c) => c !== ch.id)
                          : [...current, ch.id],
                      );
                    }}
                  />
                );
              })
            )}
          </div>
          <div className="text-[10px]" style={labelStyle}>
            Enabled channels are injected into every new session. Requires
            Claude Code v2.1.80+.
          </div>

          <div
            className="text-[10px] font-medium uppercase tracking-wide mt-3"
            style={labelStyle}
          >
            Custom Environment Variables
          </div>
          <EnvVarSection
            settings={settings}
            pendingEnvVars={pendingEnvVars}
            setPendingEnvVars={setPendingEnvVars}
            envIdCounter={envIdCounter}
            inputStyle={inputStyle}
            page={page}
            labelStyle={labelStyle}
          />

          {error && (
            <div
              className="rounded px-2 py-1.5"
              style={{ background: "#ea6c7315", color: "#ea6c73" }}
            >
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (!hasPending && !saved)}
            className="w-full rounded px-3 py-1.5 text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: saved ? "#238636" : "#16825d",
              color: "#fff",
            }}
          >
            {saveButtonLabel(saving, saved)}
          </button>

          <div className="text-[10px]" style={labelStyle}>
            Settings are injected as env vars. Save, then restart all sessions
            to apply changes to running sessions.
          </div>

          <RestartAllButton page={page} />
        </div>
      )}
    </div>
  );
}

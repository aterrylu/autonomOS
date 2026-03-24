import { useCallback, useEffect, useRef, useState } from "react";
import { Codicon, type CodiconName } from "../../components/Codicon";
import { THEMES, useStore } from "../../store";
import { useClickOutside } from "../claude-usage/useClickOutside";

interface MaskedSettings {
  claudeSessionKey: string | null;
  claudeOrgId: string | null;
  anthropicBaseUrl: string | null;
  anthropicAuthToken: string | null;
  anthropicOverrideEnabled: boolean;
  channels: string[];
}

const AVAILABLE_CHANNELS = [
  {
    id: "plugin:telegram@claude-plugins-official",
    label: "Telegram",
    icon: "comment-discussion",
  },
  {
    id: "plugin:discord@claude-plugins-official",
    label: "Discord",
    icon: "comment-discussion",
  },
  {
    id: "server:autonomos",
    label: "autonomOS",
    icon: "radio-tower",
  },
] as const;

function SettingRow({
  label,
  value,
  placeholder,
  secret,
  inputStyle,
  labelStyle,
  onChange,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  secret?: boolean;
  inputStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
  onChange: (val: string) => void;
}) {
  const isNew = !value;
  const [editing, setEditing] = useState(isNew);
  const [draft, setDraft] = useState("");

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px]" style={labelStyle}>
          {label}
        </span>
        {value && !editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setDraft("");
              onChange("");
            }}
            className="text-[10px] cursor-pointer hover:opacity-80"
            style={{ color: "#16825d" }}
          >
            Change
          </button>
        )}
        {editing && !isNew && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-[10px] cursor-pointer hover:opacity-80"
            style={labelStyle}
          >
            Cancel
          </button>
        )}
      </div>
      {editing ? (
        <input
          type={secret ? "password" : "text"}
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            onChange(v);
          }}
          placeholder={placeholder}
          className="w-full rounded px-2 py-1.5 text-xs font-mono"
          style={inputStyle}
        />
      ) : (
        <div
          className="rounded px-2 py-1.5 text-xs font-mono truncate"
          style={{ ...inputStyle, opacity: 0.8 }}
        >
          {value}
        </div>
      )}
    </div>
  );
}

function ChannelToggle({
  label,
  icon,
  enabled,
  page,
  onToggle,
}: {
  label: string;
  icon: CodiconName;
  enabled: boolean;
  page: PageTheme;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-xs cursor-pointer"
      style={{
        background: enabled ? "#16825d20" : page.border,
        border: enabled ? "1px solid #16825d50" : "1px solid transparent",
        color: page.fg,
      }}
    >
      <Codicon name={icon} size={14} />
      <span className="flex-1 text-left">{label}</span>
      <Codicon
        name={enabled ? "check" : "circle-large"}
        size={14}
        style={{ color: enabled ? "#16825d" : page.statusFg }}
      />
    </button>
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
      const res = await fetch("/api/sessions/restart-all", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { idMap } = await res.json();
      if (idMap && Object.keys(idMap).length > 0) {
        useStore.getState().remapSessionIds(idMap);
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
        {state === "done"
          ? "Restarted!"
          : state === "restarting"
            ? "Restarting..."
            : "Restart All Sessions"}
      </button>
    </div>
  );
}

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose);

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<MaskedSettings | null>(null);

  const [pending, setPending] = useState<Record<string, string>>({});
  const [pendingChannels, setPendingChannels] = useState<string[] | null>(null);

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
  }, []);

  async function handleSave() {
    const hasTextChanges = Object.keys(pending).length > 0;
    const hasChannelChanges = pendingChannels !== null;
    if (!hasTextChanges && !hasChannelChanges) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const body: Record<string, unknown> = { ...pending };
      if (pendingChannels !== null) {
        body.channels = pendingChannels;
      }
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`Failed to save (HTTP ${res.status})`);
        return;
      }
      const updated: MaskedSettings = await res.json();
      setSettings(updated);
      setPending({});
      setPendingChannels(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
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
    Object.keys(pending).length > 0 || pendingChannels !== null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-[340px] rounded-md p-3 text-xs shadow-lg"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
        zIndex: 50,
      }}
    >
      <div className="font-medium text-sm mb-3">Settings</div>

      {!loaded ? (
        <div style={labelStyle}>Loading...</div>
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div
              className="text-[10px] font-medium uppercase tracking-wide"
              style={labelStyle}
            >
              Anthropic API Override
            </div>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: toggle switch */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: toggle switch */}
            <div
              className="relative w-8 h-4 rounded-full cursor-pointer transition-colors"
              style={{
                background: settings?.anthropicOverrideEnabled
                  ? "#16825d"
                  : page.border,
              }}
              onClick={async () => {
                const newVal = !settings?.anthropicOverrideEnabled;
                try {
                  const res = await fetch("/api/settings", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      anthropicOverrideEnabled: newVal,
                    }),
                  });
                  if (res.ok) {
                    const updated: MaskedSettings = await res.json();
                    setSettings(updated);
                    setSaved(true);
                    setTimeout(() => setSaved(false), 2000);
                  }
                } catch {
                  // silent — toggle will revert visually on next open
                }
              }}
            >
              <div
                className="absolute top-0.5 w-3 h-3 rounded-full transition-transform"
                style={{
                  background: "#fff",
                  left: settings?.anthropicOverrideEnabled ? "18px" : "2px",
                }}
              />
            </div>
          </div>
          <div
            style={{
              opacity: settings?.anthropicOverrideEnabled ? 1 : 0.4,
              pointerEvents: settings?.anthropicOverrideEnabled
                ? "auto"
                : "none",
            }}
            className="space-y-2.5"
          >
            <SettingRow
              label="Base URL"
              value={settings?.anthropicBaseUrl ?? null}
              placeholder="https://api.anthropic.com (default)"
              inputStyle={inputStyle}
              labelStyle={labelStyle}
              onChange={(v) => {
                setPending((p) => ({ ...p, anthropicBaseUrl: v }));
              }}
            />
            <SettingRow
              label="Auth Token"
              value={settings?.anthropicAuthToken ?? null}
              placeholder="sk-..."
              secret
              inputStyle={inputStyle}
              labelStyle={labelStyle}
              onChange={(v) => {
                setPending((p) => ({ ...p, anthropicAuthToken: v }));
              }}
            />
          </div>

          <div
            className="text-[10px] font-medium uppercase tracking-wide mt-3"
            style={labelStyle}
          >
            Channels
          </div>
          <div className="space-y-1">
            {AVAILABLE_CHANNELS.map((ch) => {
              const current = pendingChannels ?? settings?.channels ?? [];
              const isEnabled = current.includes(ch.id);
              return (
                <ChannelToggle
                  key={ch.id}
                  label={ch.label}
                  icon={ch.icon}
                  enabled={isEnabled}
                  page={page}
                  onToggle={() => {
                    const base = pendingChannels ?? [
                      ...(settings?.channels ?? []),
                    ];
                    setPendingChannels(
                      isEnabled
                        ? base.filter((c) => c !== ch.id)
                        : [...base, ch.id],
                    );
                  }}
                />
              );
            })}
          </div>
          <div className="text-[10px]" style={labelStyle}>
            Enabled channels are injected into every new session via --channels.
            Requires Claude Code v2.1.80+.
          </div>

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
            {saved ? "Saved!" : saving ? "Saving..." : "Save"}
          </button>

          <div className="text-[10px]" style={labelStyle}>
            Settings are injected as env vars. Save, then restart sessions to
            apply to running sessions.
          </div>

          <RestartAllButton page={page} />
        </div>
      )}
    </div>
  );
}

export function SettingsStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 cursor-pointer hover:opacity-80"
        style={{ color: page.statusFg }}
        title="Settings"
      >
        <Codicon name="gear" size={14} />
      </button>
      {open && <SettingsPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

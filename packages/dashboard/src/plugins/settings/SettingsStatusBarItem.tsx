import { useEffect, useRef, useState } from "react";
import { Codicon } from "../../components/Codicon";
import { THEMES, useStore } from "../../store";
import { useClickOutside } from "../claude-usage/useClickOutside";

interface MaskedSettings {
  claudeSessionKey: string | null;
  claudeOrgId: string | null;
  anthropicBaseUrl: string | null;
  anthropicAuthToken: string | null;
}

/** A single setting row — shows saved value or edit input */
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // If no saved value, always show input
  const showInput = !value || editing;

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
            }}
            className="text-[10px] cursor-pointer hover:opacity-80"
            style={{ color: "#16825d" }}
          >
            Change
          </button>
        )}
        {editing && (
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
      {showInput ? (
        <input
          type={secret ? "password" : "text"}
          value={editing ? draft : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (editing) setDraft(v);
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

  // Pending changes (only sent on save)
  const pending = useRef<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: MaskedSettings) => {
        setSettings(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function handleSave() {
    if (Object.keys(pending.current).length === 0) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending.current),
      });
      if (!res.ok) {
        setError(`Failed to save (HTTP ${res.status})`);
        return;
      }
      const updated: MaskedSettings = await res.json();
      setSettings(updated);
      pending.current = {};
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
  const hasPending = Object.keys(pending.current).length > 0;

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
          {/* Anthropic / LiteLLM section */}
          <div
            className="text-[10px] font-medium uppercase tracking-wide"
            style={labelStyle}
          >
            Anthropic API
          </div>
          <SettingRow
            label="Base URL"
            value={settings?.anthropicBaseUrl ?? null}
            placeholder="https://api.anthropic.com (default)"
            inputStyle={inputStyle}
            labelStyle={labelStyle}
            onChange={(v) => {
              pending.current.anthropicBaseUrl = v;
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
              pending.current.anthropicAuthToken = v;
            }}
          />

          {/* Divider */}
          <div style={{ borderTop: `1px solid ${page.border}` }} />

          {/* Claude Usage section */}
          <div
            className="text-[10px] font-medium uppercase tracking-wide"
            style={labelStyle}
          >
            Claude Usage (Session Cookie)
          </div>
          <SettingRow
            label="Session Key"
            value={settings?.claudeSessionKey ?? null}
            placeholder="sk-ant-sid01-..."
            secret
            inputStyle={inputStyle}
            labelStyle={labelStyle}
            onChange={(v) => {
              pending.current.claudeSessionKey = v;
            }}
          />
          <SettingRow
            label="Org ID"
            value={settings?.claudeOrgId ?? null}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            inputStyle={inputStyle}
            labelStyle={labelStyle}
            onChange={(v) => {
              pending.current.claudeOrgId = v;
            }}
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
            {saved && "Saved!"}
            {!saved && saving && "Saving..."}
            {!saved && !saving && "Save"}
          </button>

          <div className="text-[10px]" style={labelStyle}>
            Injected as env vars into new sessions.
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsStatusBarItem() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative">
      <button
        ref={toggleRef}
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

import { useEffect, useRef, useState } from "react";
import { Codicon } from "../../components/Codicon";
import { THEMES, useStore } from "../../store";
import { useClickOutside } from "../claude-usage/useClickOutside";

interface SettingsState {
  claudeSessionKey: string | null;
  claudeOrgId: string | null;
  anthropicBaseUrl: string | null;
  anthropicAuthToken: string | null;
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

  // Form fields
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState("");
  const [anthropicAuthToken, setAnthropicAuthToken] = useState("");
  const [claudeSessionKey, setClaudeSessionKey] = useState("");
  const [claudeOrgId, setClaudeOrgId] = useState("");

  // Load current settings on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: SettingsState) => {
        // Non-secret fields get their actual values
        if (data.anthropicBaseUrl) setAnthropicBaseUrl(data.anthropicBaseUrl);
        if (data.claudeOrgId) setClaudeOrgId(data.claudeOrgId);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const body: Record<string, string> = {};
      // Always send non-secret fields
      body.anthropicBaseUrl = anthropicBaseUrl;
      body.claudeOrgId = claudeOrgId;
      // Only send secret fields if user typed a new value
      if (anthropicAuthToken) body.anthropicAuthToken = anthropicAuthToken;
      if (claudeSessionKey) body.claudeSessionKey = claudeSessionKey;

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`Failed to save (HTTP ${res.status})`);
        return;
      }
      setSaved(true);
      // Clear secret fields after save
      setAnthropicAuthToken("");
      setClaudeSessionKey("");
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Could not reach server");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = {
    background: page.border,
    color: page.fg,
    border: "none",
    outline: "none",
  };

  const labelStyle = { color: page.statusFg };

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-[380px] rounded-md p-3 text-xs shadow-lg"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
        zIndex: 50,
      }}
    >
      <div className="font-medium text-sm mb-3">Settings</div>

      {!loaded ? (
        <div style={{ color: page.statusFg }}>Loading...</div>
      ) : (
        <div className="space-y-3">
          {/* Anthropic / LiteLLM section */}
          <div
            className="text-[10px] font-medium uppercase tracking-wide"
            style={labelStyle}
          >
            Anthropic API
          </div>
          <div>
            <label
              htmlFor="settings-anthropic-url"
              className="block text-[10px] mb-0.5"
              style={labelStyle}
            >
              Base URL
            </label>
            <input
              id="settings-anthropic-url"
              type="text"
              value={anthropicBaseUrl}
              onChange={(e) => setAnthropicBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com (default)"
              className="w-full rounded px-2 py-1.5 text-xs font-mono"
              style={inputStyle}
            />
          </div>
          <div>
            <label
              htmlFor="settings-anthropic-token"
              className="block text-[10px] mb-0.5"
              style={labelStyle}
            >
              Auth Token
            </label>
            <input
              id="settings-anthropic-token"
              type="password"
              value={anthropicAuthToken}
              onChange={(e) => setAnthropicAuthToken(e.target.value)}
              placeholder="sk-... (leave blank to keep current)"
              className="w-full rounded px-2 py-1.5 text-xs font-mono"
              style={inputStyle}
            />
          </div>

          {/* Divider */}
          <div style={{ borderTop: `1px solid ${page.border}` }} />

          {/* Claude Usage section */}
          <div
            className="text-[10px] font-medium uppercase tracking-wide"
            style={labelStyle}
          >
            Claude Usage (Session Cookie)
          </div>
          <div>
            <label
              htmlFor="settings-session-key"
              className="block text-[10px] mb-0.5"
              style={labelStyle}
            >
              Session Key
            </label>
            <input
              id="settings-session-key"
              type="password"
              value={claudeSessionKey}
              onChange={(e) => setClaudeSessionKey(e.target.value)}
              placeholder="sk-ant-sid01-... (leave blank to keep current)"
              className="w-full rounded px-2 py-1.5 text-xs font-mono"
              style={inputStyle}
            />
          </div>
          <div>
            <label
              htmlFor="settings-org-id"
              className="block text-[10px] mb-0.5"
              style={labelStyle}
            >
              Org ID
            </label>
            <input
              id="settings-org-id"
              type="text"
              value={claudeOrgId}
              onChange={(e) => setClaudeOrgId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full rounded px-2 py-1.5 text-xs font-mono"
              style={inputStyle}
            />
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
            disabled={saving}
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
            Settings are injected as env vars into new sessions.
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

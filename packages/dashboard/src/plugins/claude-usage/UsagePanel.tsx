import { useEffect, useRef, useState } from "react";
import { Codicon } from "../../components/Codicon";
import { THEMES, useStore } from "../../store";
import { saveAndValidate } from "./saveAndValidate";
import {
  type AccountInfo,
  type CredentialSource,
  type DisplayMode,
  type ErrorKind,
  isAutoDetected,
  type RateLimitData,
  type RateLimitWindow,
} from "./types";
import { useClickOutside } from "./useClickOutside";
import { timeAgo, timeUntilReset, utilizationColor } from "./utils";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

function formatPlan(sub?: string): string {
  if (!sub) return "Unknown";
  return `Claude ${sub.charAt(0).toUpperCase()}${sub.slice(1)}`;
}

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function ProgressBar({ pct }: { pct: number }) {
  const color = utilizationColor(pct);
  return (
    <div
      className="h-3 w-full rounded overflow-hidden"
      style={{ background: `${color}22` }}
    >
      <div
        className="h-full rounded transition-all"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }}
      />
    </div>
  );
}

function WindowDetail({
  label,
  description,
  window,
  statusFg,
}: {
  label: string;
  description: string;
  window: RateLimitWindow;
  statusFg: string;
}) {
  const pct = Math.round(window.utilization);
  const remaining = Math.max(0, 100 - pct);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">{label}</span>
        <span style={{ color: utilizationColor(pct), fontWeight: 600 }}>
          {pct}% used
        </span>
      </div>
      <ProgressBar pct={pct} />
      <div
        className="flex items-center justify-between mt-1"
        style={{ color: statusFg }}
      >
        <span>{description}</span>
        <span>{remaining}% remaining</span>
      </div>
      {window.resetsAt && (
        <div className="mt-0.5" style={{ color: statusFg }}>
          Resets in {timeUntilReset(window.resetsAt)}
          <span className="ml-1" style={{ opacity: 0.6 }}>
            ({new Date(window.resetsAt).toLocaleTimeString()})
          </span>
        </div>
      )}
    </div>
  );
}

function CredentialField({
  label,
  value,
  placeholder,
  emptyLabel,
  secret,
  editing,
  draft,
  onEdit,
  onCancel,
  onDraftChange,
  inputStyle,
  statusFg,
  disabled,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  emptyLabel: string;
  secret?: boolean;
  editing: boolean;
  draft: string;
  onEdit: () => void;
  onCancel: () => void;
  onDraftChange: (val: string) => void;
  inputStyle: React.CSSProperties;
  statusFg: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px]" style={{ color: statusFg }}>
          {label}
        </span>
        {editing ? (
          <button
            type="button"
            onClick={onCancel}
            className="text-[10px] cursor-pointer hover:opacity-80"
            style={{ color: statusFg }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            className="text-[10px] cursor-pointer hover:opacity-80"
            style={{ color: "#16825d" }}
          >
            {value ? "Change" : "Set"}
          </button>
        )}
      </div>
      {editing ? (
        <input
          type={secret ? "password" : "text"}
          value={draft}
          disabled={disabled}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded px-2 py-1.5 text-xs font-mono disabled:opacity-60"
          style={inputStyle}
        />
      ) : (
        <div
          className="rounded px-2 py-1.5 text-xs font-mono truncate"
          style={{ ...inputStyle, opacity: 0.8 }}
        >
          {value || emptyLabel}
        </div>
      )}
    </div>
  );
}

function saveButtonLabel(saving: boolean, saved: boolean): string {
  if (saved) return "Connected ✓";
  if (saving) return "Verifying…";
  return "Save & verify";
}

/** Mirror the server's redaction so the field shows the new key immediately
 * without a settings round-trip (see `redact` in routes/settings.ts). */
function redactKey(key: string): string {
  return key.length > 8 ? `••••${key.slice(-4)}` : "••••";
}

const OAUTH_TOOLTIP =
  "autonomOS reads your Claude Code login token locally (macOS Keychain / " +
  "~/.claude), read-only — it never refreshes it, never writes it to disk, and " +
  "uses it only to call Anthropic's usage API. Paste a session key to override.";

/** Status line describing where the active usage credential comes from. */
function CredentialSourceLine({
  credentialSource,
  errorKind,
  needsSetup,
  account,
  statusFg,
}: {
  credentialSource?: CredentialSource;
  errorKind?: ErrorKind;
  needsSetup?: boolean;
  account?: AccountInfo;
  statusFg: string;
}) {
  let glyph = "○";
  let color = statusFg;
  let text: string;

  if (errorKind === "stale_token") {
    glyph = "⚠";
    color = "#d29922";
    text = "Claude Code token expired — run a session or paste a key";
  } else if (credentialSource === "oauth" && !errorKind && !needsSetup) {
    glyph = "●";
    color = "#3fb950";
    const parts = [account?.email, account?.subscriptionType]
      .filter(Boolean)
      .join(" · ");
    text = `Claude Code login (OAuth)${parts ? ` — ${parts}` : ""}`;
  } else if (credentialSource === "settings" && !errorKind) {
    glyph = "●";
    color = "#3fb950";
    text = `Manual session key${account?.email ? ` — ${account.email}` : ""}`;
  } else if (needsSetup) {
    glyph = "○";
    text = "No Claude Code login found — paste a session key";
  } else {
    // Other credential present (e.g. env) or a transient error — keep neutral.
    text =
      credentialSource === "env"
        ? "Manual session key (env)"
        : "Usage credential";
  }

  return (
    <div className="flex items-start gap-1" style={{ color }}>
      <span aria-hidden>{glyph}</span>
      <span className="flex-1">{text}</span>
      <span
        title={OAUTH_TOOLTIP}
        role="img"
        aria-label="About usage credentials"
        className="cursor-help select-none"
        style={{ color: statusFg }}
      >
        ⓘ
      </span>
    </div>
  );
}

function CredentialsSection({
  page,
  onRefetch,
  credentialSource,
  errorKind,
  needsSetup,
  account,
}: {
  page: PageTheme;
  onRefetch?: () => void;
  credentialSource?: CredentialSource;
  errorKind?: ErrorKind;
  needsSetup?: boolean;
  account?: AccountInfo;
}) {
  // When usage comes from Claude Code's OAuth login and the user hasn't pasted
  // their own key, say so explicitly instead of "Not set" — the credential
  // isn't missing, it's the zero-touch default. A manual paste still overrides.
  const autoDetected = isAutoDetected(credentialSource);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [autoDetect, setAutoDetect] = useState(true);
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!expanded || loaded) return;
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setMaskedKey(data.claudeSessionKey ?? null);
        // Prefer the new key; fall back to the legacy one for older servers.
        setAutoDetect(
          (data.autoDetectClaudeAccount ?? data.autoDetectClaudeSession) !==
            false,
        );
        setLoaded(true);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(
          `Failed to load: ${err instanceof Error ? err.message : "unknown"}`,
        );
        setLoaded(true);
      });
    return () => controller.abort();
  }, [expanded, loaded]);

  const hasPending = editingKey && keyDraft.trim().length > 0;

  async function handleSave(): Promise<void> {
    if (!hasPending) return;
    setSaving(true);
    setError("");
    const key = keyDraft.trim();
    // Save AND verify against claude.ai before showing success, so a bad key
    // reports its real reason here instead of looking saved but failing later.
    const res = await saveAndValidate(key);
    setSaving(false);
    if (res.kind === "ok") {
      setMaskedKey(redactKey(key));
      setEditingKey(false);
      setKeyDraft("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefetch?.();
    } else {
      setError(res.message);
    }
  }

  async function toggleAutoDetect(): Promise<void> {
    const next = !autoDetect;
    setAutoDetect(next); // optimistic
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoDetectClaudeAccount: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefetch?.();
    } catch {
      setAutoDetect(!next); // revert on failure
      setError("Could not update auto-detect setting");
    }
  }

  const inputStyle: React.CSSProperties = {
    background: page.border,
    color: page.fg,
    border: "none",
    outline: "none",
  };

  return (
    <div
      className="mt-3 pt-2"
      style={{ borderTop: `1px solid ${page.border}` }}
    >
      <button
        type="button"
        className="flex items-center gap-1 w-full cursor-pointer hover:opacity-80"
        style={{ color: page.statusFg }}
        onClick={() => setExpanded(!expanded)}
      >
        <Codicon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
        <span className="text-[10px] font-medium uppercase tracking-wide">
          Credentials
        </span>
      </button>
      {expanded && !loaded && (
        <div className="mt-2 text-[10px]" style={{ color: page.statusFg }}>
          Loading...
        </div>
      )}
      {expanded && loaded && (
        <div className="mt-2 space-y-2">
          <CredentialSourceLine
            credentialSource={credentialSource}
            errorKind={errorKind}
            needsSetup={needsSetup}
            account={account}
            statusFg={page.statusFg}
          />
          <CredentialField
            label="Session Key"
            value={maskedKey}
            placeholder="sk-ant-sid…"
            emptyLabel={
              autoDetected ? "Using Claude Code login (OAuth)" : "Not set"
            }
            secret
            editing={editingKey}
            draft={keyDraft}
            onEdit={() => {
              setEditingKey(true);
              setKeyDraft("");
            }}
            onCancel={() => {
              setEditingKey(false);
              setKeyDraft("");
            }}
            onDraftChange={setKeyDraft}
            inputStyle={inputStyle}
            statusFg={page.statusFg}
            disabled={saving}
          />
          {error && (
            <div
              className="rounded px-2 py-1.5"
              style={{ background: "#ea6c7315", color: "#ea6c73" }}
            >
              {error}
            </div>
          )}
          {hasPending && (
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
              {saveButtonLabel(saving, saved)}
            </button>
          )}
          {/* Auto-detect toggle: read Claude Code's OAuth login (read-only) so
              no manual paste is needed. A pasted key always overrides it. */}
          <button
            type="button"
            onClick={toggleAutoDetect}
            className="flex items-center justify-between w-full cursor-pointer hover:opacity-80"
            style={{ color: page.statusFg }}
          >
            <span className="text-[10px]">Auto-detect Claude account</span>
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-medium"
              style={{
                background: autoDetect ? "#23863622" : page.border,
                color: autoDetect ? "#3fb950" : page.statusFg,
              }}
            >
              {autoDetect ? "On" : "Off"}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

interface UsagePanelProps {
  data: RateLimitData;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  onClose: () => void;
  onRefetch?: () => void;
  toggleRef?: React.RefObject<HTMLElement | null>;
}

export function UsagePanel({
  data,
  displayMode,
  onDisplayModeChange,
  onClose,
  onRefetch,
  toggleRef,
}: UsagePanelProps) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const panelRef = useRef<HTMLDivElement>(null);
  useClickOutside(panelRef, onClose, toggleRef);

  const acct = data.account;

  return (
    <div
      ref={panelRef}
      className="absolute bottom-full right-0 mb-1 min-w-[320px] rounded-md p-3 text-xs shadow-lg"
      style={{
        background: page.bg,
        border: `1px solid ${page.border}`,
        color: page.fg,
      }}
    >
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-sm">Claude Rate Limits</span>
        {acct?.subscriptionType && (
          <span
            className="rounded px-1.5 py-0.5"
            style={{ background: "#23863622", color: "#238636" }}
          >
            {formatPlan(acct.subscriptionType)}
          </span>
        )}
      </div>

      {acct?.email && (
        <div className="mb-3" style={{ color: page.statusFg }}>
          {acct.email}
          {acct.subscriptionType && ` · ${acct.subscriptionType}`}
        </div>
      )}

      {/* Error state */}
      {data.error && (
        <div
          className="mb-3 rounded px-2 py-1.5"
          style={{ background: "#ea6c7315", color: "#ea6c73" }}
        >
          {data.error}
        </div>
      )}

      {/* Primary windows */}
      {data.fiveHour && (
        <WindowDetail
          label="5-Hour Session"
          description="Rolling window"
          window={data.fiveHour}
          statusFg={page.statusFg}
        />
      )}

      {data.sevenDay && (
        <WindowDetail
          label="7-Day Weekly"
          description="All models"
          window={data.sevenDay}
          statusFg={page.statusFg}
        />
      )}

      {/* Model-specific windows */}
      {(data.sevenDayOpus || data.sevenDaySonnet) && (
        <div
          className="mt-1 pt-2 mb-2"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          <div className="mb-2 font-medium" style={{ color: page.statusFg }}>
            Per-Model Weekly
          </div>
          {data.sevenDayOpus && (
            <WindowDetail
              label="Opus"
              description="7-day window"
              window={data.sevenDayOpus}
              statusFg={page.statusFg}
            />
          )}
          {data.sevenDaySonnet && (
            <WindowDetail
              label="Sonnet"
              description="7-day window"
              window={data.sevenDaySonnet}
              statusFg={page.statusFg}
            />
          )}
        </div>
      )}

      {/* Extra usage */}
      {data.extraUsage && (
        <div
          className="mt-1 pt-2 mb-2"
          style={{ borderTop: `1px solid ${page.border}` }}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-medium">Extra Usage</span>
            <span style={{ color: page.statusFg }}>
              {formatDollars(data.extraUsage.usedCredits)} /{" "}
              {formatDollars(data.extraUsage.monthlyLimit)}
            </span>
          </div>
        </div>
      )}

      {/* Display Options */}
      <div
        className="mt-3 pt-2 flex items-center justify-between"
        style={{ borderTop: `1px solid ${page.border}` }}
      >
        <span style={{ color: page.statusFg }}>Status bar display</span>
        <div className="flex gap-1">
          {(["text", "bar"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="rounded px-2 py-0.5 cursor-pointer"
              style={{
                background: displayMode === mode ? page.border : "transparent",
                color: displayMode === mode ? page.fg : page.statusFg,
              }}
              onClick={() => onDisplayModeChange(mode)}
            >
              {mode === "text" ? "%" : "bar"}
            </button>
          ))}
        </div>
      </div>

      {/* Metadata */}
      <div className="mt-2" style={{ color: page.statusFg }}>
        Updated {timeAgo(data.fetchedAt)}
      </div>

      {/* Credentials config */}
      <CredentialsSection
        page={page}
        onRefetch={onRefetch}
        credentialSource={data.credentialSource}
        errorKind={data.errorKind}
        needsSetup={data.needsSetup}
        account={data.account}
      />
    </div>
  );
}

import { type EnvPreset, SECRET_MASK } from "@autonomos/core";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { THEMES, useStore } from "../store";

/**
 * PresetsPanel — view and manage model-override env presets.
 *
 * A preset carries non-secret env vars (plaintext) plus declared secret keys.
 * Agents create presets via MCP tools, but the human's essential job lives HERE:
 * pasting the secret VALUE (e.g. the API key) for each declared secret key.
 * Secret values are always masked on read; typing a new value PUTs it, an empty
 * value clears it, and echoing a masked value back is a no-op (server-ignored).
 * See ADR-067.
 */

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

const PROVIDERS: NonNullable<EnvPreset["provider"]>[] = [
  "claude-code",
  "codex",
  "gemini-cli",
];

/** A secret is "set" when the masked read carries a non-empty value for it. */
function isSecretSet(preset: EnvPreset, key: string): boolean {
  return !!preset.secrets?.[key];
}

// ── Reusable key/value editor ───────────────────────────────────

function KeyValueEditor({
  entries,
  onChange,
  page,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
}: {
  entries: [string, string][];
  onChange: (next: [string, string][]) => void;
  page: PageTheme;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const inputStyle = {
    background: "rgba(0,0,0,0.3)",
    border: `1px solid ${page.border}`,
    color: "#e6e1cf",
  };
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map((entry, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div key={idx} className="flex items-center gap-1.5">
          <input
            type="text"
            value={entry[0]}
            onChange={(e) => {
              const next = entries.slice();
              next[idx] = [e.target.value, entry[1]];
              onChange(next);
            }}
            placeholder={keyPlaceholder}
            className="w-[40%] text-[11px] rounded px-1.5 py-1 font-mono"
            style={inputStyle}
          />
          <input
            type="text"
            value={entry[1]}
            onChange={(e) => {
              const next = entries.slice();
              next[idx] = [entry[0], e.target.value];
              onChange(next);
            }}
            placeholder={valuePlaceholder}
            className="flex-1 text-[11px] rounded px-1.5 py-1 font-mono"
            style={inputStyle}
          />
          <button
            type="button"
            onClick={() => onChange(entries.filter((_, i) => i !== idx))}
            className="text-[11px] px-1.5 py-0.5 rounded cursor-pointer shrink-0"
            style={{ color: "#ea6c73" }}
            title="Remove"
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...entries, ["", ""]])}
        className="text-[10px] px-2 py-0.5 rounded cursor-pointer self-start"
        style={{
          background: "rgba(255,255,255,0.06)",
          color: "#e6e1cf",
          border: `1px solid ${page.border}`,
        }}
      >
        + Add
      </button>
    </div>
  );
}

// ── Reusable string-list editor (secret key names) ──────────────

function StringListEditor({
  values,
  onChange,
  page,
  placeholder = "SECRET_KEY",
}: {
  values: string[];
  onChange: (next: string[]) => void;
  page: PageTheme;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((val, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div key={idx} className="flex items-center gap-1.5">
          <input
            type="text"
            value={val}
            onChange={(e) => {
              const next = values.slice();
              next[idx] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
            className="flex-1 text-[11px] rounded px-1.5 py-1 font-mono"
            style={{
              background: "rgba(0,0,0,0.3)",
              border: `1px solid ${page.border}`,
              color: "#e6e1cf",
            }}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, i) => i !== idx))}
            className="text-[11px] px-1.5 py-0.5 rounded cursor-pointer shrink-0"
            style={{ color: "#ea6c73" }}
            title="Remove"
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ""])}
        className="text-[10px] px-2 py-0.5 rounded cursor-pointer self-start"
        style={{
          background: "rgba(255,255,255,0.06)",
          color: "#e6e1cf",
          border: `1px solid ${page.border}`,
        }}
      >
        + Add key
      </button>
    </div>
  );
}

// ── Secret value entry (the human's essential job) ──────────────

// Exported for the DOM test (settled↔edit behavior). Not part of a public API.
export function SecretRow({
  presetName,
  keyName,
  isSet,
  maskedValue,
  page,
}: {
  presetName: string;
  keyName: string;
  isSet: boolean;
  maskedValue?: string;
  page: PageTheme;
}) {
  const updatePreset = useStore((s) => s.updatePreset);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Settled vs edit. A SET key shows a settled masked chip (no input) by
  // default; an UNSET key opens straight into entry. "Change" reveals the input;
  // saving collapses back to settled; "Clear" drops back to the unset entry.
  const [editing, setEditing] = useState(!isSet);
  // Clear destroys a human-entered credential — two-step it like Del (Nox), so a
  // mis-click next to Change can't wipe a key with no undo.
  const [confirmClear, setConfirmClear] = useState(false);

  const save = async (raw: string) => {
    setBusy(true);
    setErr(null);
    try {
      await updatePreset(presetName, { secrets: { [keyName]: raw } });
      setValue("");
      // raw === "" is a Clear → now unset, stay in entry; otherwise it's set →
      // collapse to the settled chip.
      setEditing(raw === "");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    }
    setBusy(false);
  };

  const keyLabel = (
    <span
      className="text-[11px] font-mono shrink-0"
      style={{ color: "#e6e1cf" }}
    >
      {keyName}
    </span>
  );

  // ── Settled: the key is set and we're not actively changing it ──
  if (isSet && !editing) {
    return (
      <div className="flex items-center gap-2">
        {keyLabel}
        <span
          className="text-[10px] shrink-0 px-1.5 py-0.5 rounded"
          style={{ background: "rgba(34,197,94,0.15)", color: "#91b362" }}
        >
          ✓ {maskedValue ?? SECRET_MASK}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setConfirmClear(false);
            setEditing(true);
          }}
          className="text-[10px] px-2 py-1 rounded cursor-pointer shrink-0"
          style={{ color: "#53bdfa" }}
        >
          Change
        </button>
        {confirmClear ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirmClear(false);
                save("");
              }}
              className="text-[10px] px-2 py-1 rounded cursor-pointer shrink-0 disabled:opacity-40"
              style={{ background: "#ea6c73", color: "#fff" }}
              title="Permanently clear this API key"
            >
              Confirm clear
            </button>
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="text-[10px] px-2 py-1 rounded cursor-pointer shrink-0"
              style={{ background: "rgba(255,255,255,0.06)", color: "#e6e1cf" }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmClear(true)}
            className="text-[10px] px-2 py-1 rounded cursor-pointer shrink-0"
            style={{ color: "#ea6c73" }}
            title="Clear this secret"
          >
            Clear
          </button>
        )}
        {err && (
          <span className="text-[10px] shrink-0" style={{ color: "#ea6c73" }}>
            {err}
          </span>
        )}
      </div>
    );
  }

  // ── Entry / editing ──
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {keyLabel}
        {!isSet && (
          <span
            className="text-[10px] shrink-0 px-1.5 py-0.5 rounded"
            style={{ background: "rgba(234,108,115,0.15)", color: "#ea6c73" }}
          >
            not set
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          // biome-ignore lint/a11y/noAutofocus: revealing the input IS the intent (Change / unset entry)
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) save(value);
            if (e.key === "Escape" && isSet) {
              setValue("");
              setErr(null);
              setEditing(false);
            }
          }}
          placeholder={
            isSet ? "Paste a new key to replace…" : "Paste the API key…"
          }
          autoComplete="off"
          className="flex-1 text-[11px] rounded px-2 py-1.5 font-mono"
          style={{
            background: "rgba(0,0,0,0.3)",
            border: `1px solid ${page.border}`,
            color: "#e6e1cf",
          }}
        />
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => save(value)}
          className="text-[10px] px-2.5 py-1.5 rounded cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: "rgba(34,197,94,0.15)",
            color: "#91b362",
            border: "1px solid rgba(34,197,94,0.3)",
          }}
        >
          Save
        </button>
        {isSet && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setValue("");
              setErr(null);
              setEditing(false);
            }}
            className="text-[10px] px-2 py-1.5 rounded cursor-pointer shrink-0 disabled:opacity-40"
            style={{ color: page.statusFg }}
            title="Cancel (keep the current key)"
          >
            Cancel
          </button>
        )}
      </div>
      {err && (
        <span className="text-[10px]" style={{ color: "#ea6c73" }}>
          {err}
        </span>
      )}
    </div>
  );
}

// ── Preset card ─────────────────────────────────────────────────

function PresetCard({ preset, page }: { preset: EnvPreset; page: PageTheme }) {
  const { updatePreset, deletePreset } = useStore(
    useShallow((s) => ({
      updatePreset: s.updatePreset,
      deletePreset: s.deletePreset,
    })),
  );

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Draft metadata (only when editing)
  const [description, setDescription] = useState(preset.description ?? "");
  const [label, setLabel] = useState(preset.label ?? "");
  const [provider, setProvider] = useState<EnvPreset["provider"] | "">(
    preset.provider ?? "",
  );
  const [envEntries, setEnvEntries] = useState<[string, string][]>(
    Object.entries(preset.env ?? {}),
  );
  const [secretKeys, setSecretKeys] = useState<string[]>(
    preset.secretKeys ?? [],
  );

  const startEdit = () => {
    setDescription(preset.description ?? "");
    setLabel(preset.label ?? "");
    setProvider(preset.provider ?? "");
    setEnvEntries(Object.entries(preset.env ?? {}));
    setSecretKeys(preset.secretKeys ?? []);
    setSaveErr(null);
    setEditing(true);
  };

  const saveEdit = async () => {
    setSaveErr(null);
    const env: Record<string, string> = {};
    for (const [k, v] of envEntries) {
      if (k.trim()) env[k.trim()] = v;
    }
    const keys = secretKeys.map((k) => k.trim()).filter(Boolean);
    try {
      await updatePreset(preset.name, {
        description,
        label,
        provider: provider || undefined,
        env,
        secretKeys: keys,
      });
      setEditing(false);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const handleDelete = async () => {
    setDeleteErr(null);
    try {
      await deletePreset(preset.name);
    } catch (e) {
      // Surface to the user like every other mutation in this panel — a
      // swallowed DELETE (e.g. server 500) left the human thinking a preset
      // with its API key was gone when it wasn't (ADR-067 polish).
      setDeleteErr(e instanceof Error ? e.message : "Failed to delete");
    }
  };

  return (
    <div
      className="relative group"
      style={{
        background: "rgba(28, 36, 51, 0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span
            className="text-[13px] font-semibold tracking-tight truncate"
            style={{ color: "#e6e1cf" }}
          >
            {preset.name}
          </span>
          {preset.label && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
              style={{
                background: "rgba(83,189,250,0.15)",
                color: "#53bdfa",
              }}
            >
              {preset.label}
            </span>
          )}
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="text-[10px] px-2 py-0.5 rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            style={{
              background: "rgba(255,255,255,0.06)",
              color: "#e6e1cf",
              border: `1px solid ${page.border}`,
            }}
          >
            Edit
          </button>
        )}
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleDelete}
              className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
              style={{ background: "#ea6c73", color: "#fff" }}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="text-[10px] px-2 py-0.5 rounded cursor-pointer"
              style={{ background: "rgba(255,255,255,0.06)", color: "#e6e1cf" }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: "#ea6c73" }}
            title="Delete"
          >
            Del
          </button>
        )}
      </div>

      {deleteErr && (
        <div className="text-[11px] mb-2" style={{ color: "#ea6c73" }}>
          {deleteErr}
        </div>
      )}

      {/* Meta line */}
      <div className="text-[11px] mb-2" style={{ color: page.statusFg }}>
        <span>{preset.provider ?? "claude-code"}</span>
        {preset.description && !editing && (
          <>
            <span className="opacity-40 mx-1.5">&middot;</span>
            <span>{preset.description}</span>
          </>
        )}
      </div>

      {/* API keys — the human's essential job, always visible */}
      <div
        className="rounded p-2.5 mb-2"
        style={{
          background: "rgba(230,180,80,0.06)",
          border: "1px solid rgba(230,180,80,0.2)",
        }}
      >
        <div
          className="text-[10px] uppercase tracking-wide font-semibold mb-1.5"
          style={{ color: "#e6b450" }}
        >
          API Keys
        </div>
        {preset.secretKeys.length === 0 ? (
          <div className="text-[10px] italic" style={{ color: page.statusFg }}>
            No secret keys declared. Add one in Edit to require an API key.
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {preset.secretKeys.map((key) => (
              <SecretRow
                key={key}
                presetName={preset.name}
                keyName={key}
                isSet={isSecretSet(preset, key)}
                maskedValue={preset.secrets?.[key]}
                page={page}
              />
            ))}
          </div>
        )}
      </div>

      {/* Environment (read-only view) */}
      {!editing && Object.keys(preset.env ?? {}).length > 0 && (
        <div className="flex flex-col gap-0.5">
          {Object.entries(preset.env).map(([k, v]) => (
            <div
              key={k}
              className="text-[10px] font-mono truncate"
              style={{ color: page.statusFg }}
              title={`${k}=${v}`}
            >
              <span style={{ color: "#e6e1cf" }}>{k}</span>={v}
            </div>
          ))}
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="flex flex-col gap-3 mt-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: page.statusFg }}>
              Label
            </span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Kimi K2.7-code"
              className="text-[11px] rounded px-2 py-1.5"
              style={{
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: page.statusFg }}>
              Description
            </span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="text-[11px] rounded px-2 py-1.5"
              style={{
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: page.statusFg }}>
              Provider
            </span>
            <select
              value={provider}
              onChange={(e) =>
                setProvider(e.target.value as EnvPreset["provider"] | "")
              }
              className="text-[11px] rounded px-2 py-1.5 cursor-pointer"
              style={{
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
              }}
            >
              <option value="">claude-code (default)</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: page.statusFg }}>
              Environment variables (non-secret)
            </span>
            <KeyValueEditor
              entries={envEntries}
              onChange={setEnvEntries}
              page={page}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px]" style={{ color: page.statusFg }}>
              Secret key names (values entered above)
            </span>
            <StringListEditor
              values={secretKeys}
              onChange={setSecretKeys}
              page={page}
            />
          </div>
          {saveErr && (
            <span className="text-[10px]" style={{ color: "#ea6c73" }}>
              {saveErr}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveEdit}
              className="text-[11px] px-3 py-1 rounded cursor-pointer"
              style={{ background: "#238636", color: "#fff" }}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[11px] px-3 py-1 rounded cursor-pointer"
              style={{
                background: "rgba(255,255,255,0.06)",
                color: "#e6e1cf",
                border: `1px solid ${page.border}`,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Create form ─────────────────────────────────────────────────

function CreateForm({ page, onDone }: { page: PageTheme; onDone: () => void }) {
  const createPreset = useStore((s) => s.createPreset);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<EnvPreset["provider"] | "">("");
  const [envEntries, setEnvEntries] = useState<[string, string][]>([]);
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(null);
    if (!name.trim()) {
      setErr("Name is required");
      return;
    }
    const env: Record<string, string> = {};
    for (const [k, v] of envEntries) {
      if (k.trim()) env[k.trim()] = v;
    }
    const keys = secretKeys.map((k) => k.trim()).filter(Boolean);
    setBusy(true);
    try {
      await createPreset({
        name: name.trim(),
        label: label.trim() || undefined,
        description: description.trim() || undefined,
        provider: provider || undefined,
        env,
        secretKeys: keys,
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create preset");
    }
    setBusy(false);
  };

  const inputStyle = {
    background: "rgba(0,0,0,0.3)",
    border: `1px solid ${page.border}`,
    color: "#e6e1cf",
  };

  return (
    <div
      className="flex flex-col gap-3 mb-4"
      style={{
        background: "rgba(28, 36, 51, 0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <span className="text-[13px] font-semibold" style={{ color: "#e6e1cf" }}>
        New preset
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Name (lowercase, digits, hyphens)
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. kimi-k2"
          className="text-[11px] rounded px-2 py-1.5 font-mono"
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Label
        </span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Kimi K2.7-code"
          className="text-[11px] rounded px-2 py-1.5"
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Description
        </span>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="text-[11px] rounded px-2 py-1.5"
          style={inputStyle}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Provider
        </span>
        <select
          value={provider}
          onChange={(e) =>
            setProvider(e.target.value as EnvPreset["provider"] | "")
          }
          className="text-[11px] rounded px-2 py-1.5 cursor-pointer"
          style={inputStyle}
        >
          <option value="">claude-code (default)</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Environment variables (non-secret)
        </span>
        <KeyValueEditor
          entries={envEntries}
          onChange={setEnvEntries}
          page={page}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          Secret key names (set values after creating)
        </span>
        <StringListEditor
          values={secretKeys}
          onChange={setSecretKeys}
          page={page}
        />
      </div>
      {err && (
        <span className="text-[10px]" style={{ color: "#ea6c73" }}>
          {err}
        </span>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="text-[11px] px-3 py-1 rounded cursor-pointer disabled:opacity-50"
          style={{ background: "#238636", color: "#fff" }}
        >
          {busy ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-[11px] px-3 py-1 rounded cursor-pointer"
          style={{
            background: "rgba(255,255,255,0.06)",
            color: "#e6e1cf",
            border: `1px solid ${page.border}`,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────

function EmptyState({ page }: { page: PageTheme }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 h-full text-center px-8"
      style={{ color: page.statusFg }}
    >
      <span className="text-[14px] font-medium" style={{ color: "#e6e1cf" }}>
        No presets yet
      </span>
      <div className="text-[11px] leading-relaxed max-w-sm opacity-80">
        Presets override an agent's model backend via environment variables. Add
        one with New preset, or ask an agent to create one via the{" "}
        <code
          className="text-[10px] px-1 py-0.5 rounded"
          style={{ background: "rgba(255,255,255,0.06)" }}
        >
          create_env_preset
        </code>{" "}
        tool — then paste the API key here.
      </div>
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────

export function PresetsPanel() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const presets = useStore((s) => s.presets);
  const presetsLoading = useStore((s) => s.presetsLoading);
  const presetsError = useStore((s) => s.presetsError);
  const fetchPresets = useStore((s) => s.fetchPresets);

  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchPresets();
    const interval = setInterval(fetchPresets, 10000);
    return () => clearInterval(interval);
  }, [fetchPresets]);

  const names = Object.keys(presets).sort();

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ background: page.bg, color: page.fg }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <div>
          <h2
            className="text-[15px] font-semibold tracking-tight"
            style={{ color: "#e6e1cf" }}
          >
            Presets
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: page.statusFg }}>
            Model-override env presets &middot; paste API keys here
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="text-xs rounded px-2 py-0.5 cursor-pointer"
          style={{ background: "#238636", color: "#fff" }}
        >
          + New
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {creating && (
          <div className="max-w-2xl">
            <CreateForm page={page} onDone={() => setCreating(false)} />
          </div>
        )}

        {presetsLoading && names.length === 0 && (
          <div
            className="text-sm flex items-center justify-center h-full"
            style={{ color: page.statusFg }}
          >
            Loading presets...
          </div>
        )}

        {presetsError && !presetsLoading && (
          <div className="text-sm" style={{ color: "#ea6c73" }}>
            {presetsError}
          </div>
        )}

        {!presetsLoading &&
          !presetsError &&
          names.length === 0 &&
          !creating && <EmptyState page={page} />}

        {names.length > 0 && (
          <div className="flex flex-col gap-3 max-w-2xl">
            {names.map((name) => (
              <PresetCard key={name} preset={presets[name]} page={page} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

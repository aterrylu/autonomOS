import {
  type AgentTemplate,
  completePermission,
  formatPermission,
  type Provider,
  type RuntimePermission,
  samePermission,
  widerAxes,
} from "@autonomos/core";
import { useMemo, useState } from "react";
import { templatesApi } from "../api/config";
import { templatesPoll } from "../api/polls";
import { usePoll } from "../api/usePoll";
import { useUndoableTextValue } from "../hooks/useUndoableTextValue";
import { THEMES, useStore } from "../store";
import {
  knownDefault,
  neverAsksTone,
  PERMISSION_RUNTIMES,
  PermissionChip,
  pinsToTemplatePermissions,
  RUNTIME_NAMES,
  RuntimeAxisFields,
  type RuntimeDefaultsState,
  templatePin,
  templatePins,
  unknownDefaultText,
  useRuntimeDefaults,
} from "./RuntimePermission";
import { isLightBg } from "./recency";

/**
 * TemplatesPanel — manage agent templates (~/.autonomos/templates/*.json).
 *
 * Two modes:
 *   - list: grid of template cards + "New Template" button
 *   - edit: form for a single template (create or update)
 *
 * Running agent count is derived from live sessions whose `template`
 * field matches the template name. Templates are immutable snapshots
 * once an agent is spawned — edits only affect newly spawned agents.
 *
 * Templates come from the shared `templatesPoll` (10s, the panel's old
 * cadence — it keeps the running counts fresh). Save/delete reconcile by
 * awaiting `templatesPoll.refresh()` before the editor closes, so the list the
 * user lands back on already reflects the write.
 */

// ── Types ────────────────────────────────────────────────────────

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

/** The panel's surfaces from the theme — it used to hardcode dark-only
 *  literals, which painted dark cards with pale text on Daylight. */
function tpl(page: PageTheme) {
  const light = isLightBg(page.bg);
  return light
    ? {
        title: page.fg,
        card: "#ffffff",
        cardBorder: page.border,
        input: "rgba(0,0,0,0.03)",
        subtle: "rgba(0,0,0,0.05)",
      }
    : {
        title: "#e6e1cf",
        card: "rgba(28, 36, 51, 0.6)",
        cardBorder: "rgba(255,255,255,0.06)",
        input: "rgba(0,0,0,0.3)",
        subtle: "rgba(255,255,255,0.06)",
      };
}

type PanelMode =
  | { kind: "list" }
  | { kind: "edit"; name: string; existing: boolean };

// ── Running agent count ──────────────────────────────────────────

/**
 * Build a lookup: template name → count of running (non-exited) agents
 * using that template. Sessions carry a `template` field in their
 * metadata; we just count matches.
 */
function useRunningAgentsByTemplate(): Record<string, number> {
  const sessions = useStore((s) => s.sessions);
  return useMemo(() => {
    const counts: Record<string, number> = {};
    for (const session of sessions) {
      if (session.status === "stopped" || session.status === "exited") continue;
      const { template } = session;
      if (typeof template === "string" && template.length > 0) {
        counts[template] = (counts[template] ?? 0) + 1;
      }
    }
    return counts;
  }, [sessions]);
}

// ── Per-runtime permission pins (ADR-115) ────────────────────────

type Pins = Partial<Record<Provider, RuntimePermission>>;

/** Runtimes whose stored pin no longer parses: the server ignores them (the
 *  agent gets your default), so they're SHOWN as ignored — and kept on save
 *  unless explicitly removed, so an unrelated edit never erases them. */
function invalidPins(
  template: AgentTemplate | undefined,
): Partial<Record<Provider, Record<string, string>>> {
  const out: Partial<Record<Provider, Record<string, string>>> = {};
  for (const r of PERMISSION_RUNTIMES) {
    const raw = template?.permissions?.[r];
    if (raw && !templatePin(template, r)) out[r] = raw;
  }
  return out;
}

/** A template saved with `pins` — every other field kept, the legacy
 *  shared-vocabulary mode dropped (`templatePins` already made it explicit),
 *  and invalid pins kept unless listed in `drop`. */
function withPins(
  template: AgentTemplate,
  pins: Pins,
  drop: readonly Provider[] = [],
): AgentTemplate {
  const { permissionMode: _legacy, permissions: _old, ...rest } = template;
  const permissions: NonNullable<AgentTemplate["permissions"]> = {
    ...pinsToTemplatePermissions(pins),
  };
  for (const [r, raw] of Object.entries(invalidPins(template)) as [
    Provider,
    Record<string, string>,
  ][])
    if (!drop.includes(r) && !pins[r]) permissions[r] = raw;
  return Object.keys(permissions).length > 0 ? { ...rest, permissions } : rest;
}

/**
 * One row per runtime: the template's pin, or "follows your default". "Use
 * default" drops a pin — and when your default lets agents do MORE than the
 * pin (or your default couldn't be loaded, so that can't be ruled out), it
 * says so and asks first. Never silently.
 * `onChange` (editor only) makes each pin editable and unpinned rows pinnable.
 */
function TemplatePins({
  pins,
  invalid,
  defaults,
  page,
  disabled,
  onUseDefault,
  onChange,
}: {
  pins: Pins;
  invalid: Partial<Record<Provider, Record<string, string>>>;
  defaults: RuntimeDefaultsState;
  page: PageTheme;
  disabled?: boolean;
  onUseDefault: (runtime: Provider) => void;
  onChange?: (pin: RuntimePermission) => void;
}) {
  const [confirming, setConfirming] = useState<Provider | null>(null);
  const tone = neverAsksTone(page);
  const small =
    "rounded px-2 py-0.5 text-[10px] cursor-pointer disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2" data-testid="template-pins">
      {PERMISSION_RUNTIMES.map((r) => {
        const pin = pins[r];
        const bad = invalid[r];
        const def = knownDefault(defaults, r);
        const widens = pin && def ? widerAxes(pin, def) : [];
        const askFirst = !!pin && (!def || widens.length > 0);
        const clear = () => (askFirst ? setConfirming(r) : onUseDefault(r));
        return (
          <div
            key={r}
            data-runtime={r}
            className="flex flex-col gap-1.5 text-[11px]"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="w-[74px] shrink-0"
                style={{ color: page.statusFg }}
              >
                {RUNTIME_NAMES[r]}
              </span>
              {pin && !onChange && (
                <PermissionChip permission={pin} page={page} />
              )}
              {pin && def && !samePermission(pin, def) && (
                <span
                  className="text-[10px] px-1.5 py-px rounded"
                  style={{
                    color: page.fg,
                    background: "rgba(83,189,250,0.10)",
                  }}
                >
                  overrides your default{" "}
                  <span className="font-mono">{formatPermission(def)}</span>
                </span>
              )}
              {pin && def && samePermission(pin, def) && (
                <span className="text-[10px]" style={{ color: page.statusFg }}>
                  pinned · same as your default
                </span>
              )}
              {!pin && bad && (
                <span
                  data-testid="invalid-pin"
                  className="text-[10px]"
                  style={{ color: tone.fg }}
                >
                  pin{" "}
                  <span className="font-mono">
                    {Object.entries(bad)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")}
                  </span>{" "}
                  isn't a valid value any more, so it's ignored: agents get your
                  default
                </span>
              )}
              {!pin && def && (
                <>
                  <PermissionChip permission={def} page={page} />
                  {!bad && (
                    <span
                      className="text-[10px]"
                      style={{ color: page.statusFg }}
                    >
                      follows your default
                    </span>
                  )}
                </>
              )}
              {!def && !pin && !bad && (
                <span className="text-[10px]" style={{ color: page.statusFg }}>
                  follows your default ({unknownDefaultText(defaults)})
                </span>
              )}
              <span className="ml-auto flex gap-1.5">
                {(pin || bad) && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      bad && !pin ? onUseDefault(r) : clear();
                    }}
                    className={small}
                    style={{
                      border: `1px solid ${page.border}`,
                      color: page.fg,
                    }}
                  >
                    {bad && !pin ? "Remove" : "Use default"}
                  </button>
                )}
                {!pin && onChange && (
                  <button
                    type="button"
                    onClick={() => onChange(def ?? completePermission(r))}
                    className={small}
                    style={{
                      border: `1px solid ${page.border}`,
                      color: page.fg,
                    }}
                  >
                    Pin
                  </button>
                )}
              </span>
            </div>
            {pin && onChange && (
              <div className="pl-[82px]">
                <RuntimeAxisFields
                  permission={pin}
                  onChange={onChange}
                  page={page}
                  defaults={def}
                  idPrefix={`tmpl-${r}`}
                />
              </div>
            )}
            {confirming === r && pin && (
              // biome-ignore lint/a11y/noStaticElementInteractions: stops the card's click-to-edit
              <div
                data-testid="confirm-use-default"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                className="rounded px-2 py-1.5 flex flex-col gap-1.5 text-[10px] leading-relaxed"
                style={{ color: tone.fg, background: tone.bg }}
              >
                {def ? (
                  <div>
                    Your {RUNTIME_NAMES[r]} default lets agents do more than
                    this pin:{" "}
                    {widens.map((w, i) => (
                      <span key={w.axis}>
                        {i > 0 && "; "}
                        <span className="font-mono">
                          {w.axis} {w.from} → {w.to}
                        </span>
                      </span>
                    ))}
                    . Agents from this template would run as{" "}
                    <span className="font-mono">{formatPermission(def)}</span>.
                  </div>
                ) : (
                  <div>
                    Your {RUNTIME_NAMES[r]} default isn't known here (
                    {unknownDefaultText(defaults)}), so it may let agents do
                    more than this pin.
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setConfirming(null);
                      onUseDefault(r);
                    }}
                    className="rounded px-2 py-0.5 cursor-pointer font-medium disabled:opacity-50"
                    style={{ background: tone.fg, color: page.bg }}
                  >
                    Use default anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-2 py-0.5 cursor-pointer"
                    style={{ background: page.border, color: page.fg }}
                  >
                    Keep pin
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────

interface TemplateCardProps {
  name: string;
  template: AgentTemplate;
  runningCount: number;
  page: PageTheme;
  defaults: RuntimeDefaultsState;
  onEdit: () => void;
}

function TemplateCard({
  name,
  template,
  runningCount,
  page,
  defaults,
  onEdit,
}: TemplateCardProps) {
  const [error, setError] = useState<string | null>(null);
  // One save at a time: each builds from the snapshot, so a second click
  // mid-save would rebuild from a stale one and restore the first pin.
  const [saving, setSaving] = useState(false);
  const pins = templatePins(template);
  const clearPin = async (r: Provider) => {
    setError(null);
    setSaving(true);
    const next = { ...pins };
    delete next[r];
    try {
      await templatesApi.save(name, withPins(template, next, [r]));
      await templatesPoll.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: card with nested buttons
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onEdit()}
      className="text-left cursor-pointer transition-all duration-200 relative group"
      style={{
        background: tpl(page).card,
        border: `1px solid ${tpl(page).cardBorder}`,
        borderRadius: 12,
        padding: "16px 18px",
        minWidth: 240,
      }}
    >
      {/* Accent line */}
      <div
        className="absolute top-0 left-3 right-3 h-[2px] rounded-full"
        style={{
          background:
            runningCount > 0
              ? "linear-gradient(90deg, #22c55e, #10b981)"
              : tpl(page).cardBorder,
        }}
      />

      {/* Header row */}
      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div
            className="text-[14px] font-semibold tracking-tight truncate"
            style={{ color: tpl(page).title }}
          >
            {template.role}
          </div>
          <div
            className="text-[10px] font-mono truncate opacity-60"
            style={{ color: page.statusFg }}
          >
            {name}
          </div>
        </div>
        {template.model && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0"
            style={{
              background: "rgba(147,51,234,0.15)",
              color: "#c4b5fd",
              letterSpacing: "0.02em",
            }}
          >
            {template.model}
          </span>
        )}
      </div>

      {/* Description */}
      <div
        className="text-[11px] leading-relaxed mb-3 line-clamp-2"
        style={{ color: page.statusFg, minHeight: 28 }}
      >
        {template.description || "No description"}
      </div>

      <div className="mb-3">
        <TemplatePins
          pins={pins}
          invalid={invalidPins(template)}
          defaults={defaults}
          page={page}
          disabled={saving}
          onUseDefault={(r) => void clearPin(r)}
        />
        {error && (
          <div className="text-[10px] mt-1" style={{ color: "#ea6c73" }}>
            {error}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end">
        <span
          className="text-[10px] font-medium"
          style={{ color: runningCount > 0 ? "#91b362" : page.statusFg }}
        >
          {runningCount} running
        </span>
      </div>
    </div>
  );
}

// ── List view ────────────────────────────────────────────────────

interface ListViewProps {
  templates: Record<string, AgentTemplate>;
  loading: boolean;
  error: string | null;
  page: PageTheme;
  defaults: RuntimeDefaultsState;
  onEdit: (name: string) => void;
  onNew: () => void;
}

function ListView({
  templates,
  loading,
  error,
  page,
  defaults,
  onEdit,
  onNew,
}: ListViewProps) {
  const runningCounts = useRunningAgentsByTemplate();
  const names = Object.keys(templates).sort();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <div>
          <h2
            className="text-[15px] font-semibold tracking-tight"
            style={{ color: tpl(page).title }}
          >
            Templates
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: page.statusFg }}>
            Blueprints for spawning agents — role, system prompt, and
            permissions
          </p>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="rounded px-3 py-1.5 text-xs cursor-pointer font-medium"
          style={{ background: "#238636", color: "#fff" }}
        >
          + New Template
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {loading && (
          <div
            className="text-sm flex items-center justify-center h-full"
            style={{ color: page.statusFg }}
          >
            Loading templates…
          </div>
        )}

        {error && !loading && (
          <div className="text-sm" style={{ color: "#ea6c73" }}>
            {error}
          </div>
        )}

        {!loading && !error && names.length === 0 && (
          <div
            className="text-sm flex flex-col items-center justify-center gap-2 h-full"
            style={{ color: page.statusFg }}
          >
            <span>No templates yet</span>
            <span className="text-xs opacity-60">
              Click "+ New Template" to create one
            </span>
          </div>
        )}

        {!loading && names.length > 0 && (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
            }}
          >
            {names.map((name) => (
              <TemplateCard
                key={name}
                name={name}
                template={templates[name]}
                runningCount={runningCounts[name] ?? 0}
                page={page}
                defaults={defaults}
                onEdit={() => onEdit(name)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Field helper ────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <span
            className="text-[11px] font-medium uppercase tracking-wide"
            style={{ color: "#b3b1ad" }}
          >
            {label}
          </span>
          {hint && (
            <span className="text-[10px] italic opacity-70">{hint}</span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Editor view ──────────────────────────────────────────────────

interface EditorViewProps {
  name: string;
  existing: boolean;
  template: AgentTemplate | undefined;
  page: PageTheme;
  defaults: RuntimeDefaultsState;
  onCancel: () => void;
  onSaved: () => void;
}

function EditorView({
  name: initialName,
  existing,
  template,
  page,
  defaults,
  onCancel,
  onSaved,
}: EditorViewProps) {
  const runningCounts = useRunningAgentsByTemplate();
  const runningCount = runningCounts[initialName] ?? 0;

  const [name, setName] = useState(initialName);
  const [role, setRole] = useState(template?.role ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    template?.systemPrompt ?? "",
  );
  // Restore Cmd/Ctrl+Z undo for the controlled System Prompt textarea —
  // React's value replacement wipes the browser's native undo stack.
  const systemPromptUndo = useUndoableTextValue(systemPrompt, setSystemPrompt);
  // Per-runtime pins; a legacy shared-vocabulary mode loads as the explicit
  // pins it always ran, so saving never changes what the template runs.
  const [pins, setPins] = useState<Pins>(() => templatePins(template));
  // Invalid stored pins the user removed here (kept on save otherwise).
  const [dropped, setDropped] = useState<Provider[]>([]);
  const [model, setModel] = useState(template?.model ?? "");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = async () => {
    setError(null);

    // Validate required fields (description is optional/cosmetic)
    if (!name.trim() || !role.trim() || !systemPrompt.trim()) {
      setError("Name, role, and system prompt are required");
      return;
    }

    // Client-side name format check for fast feedback
    if (!existing && !/^[a-z0-9][a-z0-9-]*$/.test(name.trim())) {
      setError(
        "Name must be lowercase letters, digits, and hyphens (e.g. feature-worker)",
      );
      return;
    }

    setSubmitting(true);
    try {
      // Every field this editor doesn't show (e.g. a future one) is kept:
      // the server overwrites the whole file.
      const { model: _model, ...kept } = template ?? ({} as AgentTemplate);
      const payload = withPins(
        {
          ...kept,
          role: role.trim(),
          description: description.trim(),
          systemPrompt,
          ...(model.trim() ? { model: model.trim() } : {}),
        },
        pins,
        dropped,
      );
      await templatesApi.save(name.trim(), payload);
      // Reconcile while the button still reads "Saving…", so the list behind
      // the editor is already truthful when we navigate back to it.
      await templatesPoll.refresh();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!existing) return;
    setSubmitting(true);
    try {
      await templatesApi.remove(initialName);
      await templatesPoll.refresh();
      setSubmitting(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-6 py-4 shrink-0"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded px-2 py-1 text-[13px]"
          style={{
            color: page.statusFg,
            background: tpl(page).subtle,
          }}
          title="Back to templates"
        >
          ← Back
        </button>
        <div className="flex-1 min-w-0">
          <h2
            className="text-[15px] font-semibold tracking-tight truncate"
            style={{ color: tpl(page).title }}
          >
            {existing ? `Edit: ${initialName}` : "New Template"}
          </h2>
          {existing && runningCount > 0 && (
            <p
              className="text-[10px] mt-0.5 italic"
              style={{ color: "#93c5fd" }}
            >
              Changes only apply to newly spawned agents. {runningCount} running
              agent{runningCount === 1 ? "" : "s"} will keep their current
              config.
            </p>
          )}
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-2xl mx-auto flex flex-col gap-5">
          {/* Name */}
          <Field label="Name" hint={existing ? "Immutable (filename)" : ""}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={existing}
              placeholder="lowercase-with-dashes"
              className="w-full rounded px-3 py-2 text-[13px] font-mono disabled:opacity-50"
              style={{
                background: tpl(page).input,
                border: `1px solid ${page.border}`,
                color: tpl(page).title,
              }}
            />
          </Field>

          {/* Role */}
          <Field label="Role">
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Feature Worker"
              className="w-full rounded px-3 py-2 text-[13px]"
              style={{
                background: tpl(page).input,
                border: `1px solid ${page.border}`,
                color: tpl(page).title,
              }}
            />
          </Field>

          {/* Description */}
          <Field label="Description">
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short summary of what this template is for"
              className="w-full rounded px-3 py-2 text-[13px]"
              style={{
                background: tpl(page).input,
                border: `1px solid ${page.border}`,
                color: tpl(page).title,
              }}
            />
          </Field>

          {/* System Prompt */}
          <Field label="System Prompt">
            <textarea
              value={systemPrompt}
              onChange={systemPromptUndo.onChange}
              onKeyDown={systemPromptUndo.onKeyDown}
              placeholder="You are a ..."
              rows={12}
              className="w-full rounded px-3 py-2 text-[12px] font-mono resize-y"
              style={{
                background: tpl(page).input,
                border: `1px solid ${page.border}`,
                color: tpl(page).title,
                minHeight: 180,
              }}
            />
          </Field>

          {/* Per-runtime permission pins */}
          <Field
            label="Permissions"
            hint="Pin a runtime's own value, or follow your default in Settings → Runtimes"
          >
            <TemplatePins
              pins={pins}
              invalid={Object.fromEntries(
                Object.entries(invalidPins(template)).filter(
                  ([r]) => !dropped.includes(r as Provider),
                ),
              )}
              defaults={defaults}
              page={page}
              onUseDefault={(r) => {
                setDropped((cur) => [...cur, r]);
                setPins((cur) => {
                  const next = { ...cur };
                  delete next[r];
                  return next;
                });
              }}
              onChange={(p) => setPins((cur) => ({ ...cur, [p.runtime]: p }))}
            />
          </Field>

          {/* Model */}
          <Field
            label="Model"
            hint="Optional (e.g. opus, sonnet) — leave empty for CC default"
          >
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="opus"
              className="w-full rounded px-3 py-2 text-[13px] font-mono"
              style={{
                background: tpl(page).input,
                border: `1px solid ${page.border}`,
                color: tpl(page).title,
              }}
            />
          </Field>

          {/* Error */}
          {error && (
            <div
              className="text-[12px] px-3 py-2 rounded"
              style={{
                background: "rgba(234,108,115,0.1)",
                color: "#ea6c73",
                border: "1px solid rgba(234,108,115,0.3)",
              }}
            >
              {error}
            </div>
          )}

          {/* Actions */}
          <div
            className="flex items-center gap-2 pt-2"
            style={{ borderTop: `1px solid ${page.border}` }}
          >
            <button
              type="button"
              onClick={handleSave}
              disabled={submitting}
              className="rounded px-4 py-2 text-[12px] font-medium cursor-pointer disabled:opacity-50"
              style={{ background: "#238636", color: "#fff" }}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded px-4 py-2 text-[12px] cursor-pointer disabled:opacity-50"
              style={{
                background: tpl(page).subtle,
                color: tpl(page).title,
              }}
            >
              Cancel
            </button>

            {existing && (
              <div className="ml-auto">
                {confirmDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px]" style={{ color: "#ea6c73" }}>
                      Delete permanently?
                    </span>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={submitting}
                      className="rounded px-3 py-1.5 text-[11px] font-medium cursor-pointer disabled:opacity-50"
                      style={{ background: "#ea6c73", color: "#fff" }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="rounded px-3 py-1.5 text-[11px] cursor-pointer"
                      style={{
                        background: tpl(page).subtle,
                        color: tpl(page).title,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={submitting}
                    className="rounded px-3 py-1.5 text-[11px] cursor-pointer disabled:opacity-50"
                    style={{
                      background: "rgba(234,108,115,0.1)",
                      color: "#ea6c73",
                      border: "1px solid rgba(234,108,115,0.3)",
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────

export function TemplatesPanel() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const { data, error } = usePoll(templatesPoll);

  const templates = data ?? {};
  // Pre-first-response only, as before; a later failure keeps the last list
  // on screen and shows the error beside it.
  const templatesLoading = data === null && error === null;
  const templatesError = error?.message ?? null;

  const [mode, setMode] = useState<PanelMode>({ kind: "list" });
  const defaults = useRuntimeDefaults();

  // The editor already refreshed the poll before calling back, so this only
  // has to switch views.
  const handleSaved = () => {
    setMode({ kind: "list" });
  };

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ background: page.bg, color: page.fg }}
    >
      {mode.kind === "list" ? (
        <ListView
          templates={templates}
          loading={templatesLoading}
          error={templatesError}
          page={page}
          defaults={defaults}
          onEdit={(name) => setMode({ kind: "edit", name, existing: true })}
          onNew={() => setMode({ kind: "edit", name: "", existing: false })}
        />
      ) : (
        <EditorView
          name={mode.name}
          existing={mode.existing}
          template={mode.existing ? templates[mode.name] : undefined}
          page={page}
          defaults={defaults}
          onCancel={() => setMode({ kind: "list" })}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

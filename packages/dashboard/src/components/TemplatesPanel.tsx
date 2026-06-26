import type { AgentCapability, AgentTemplate } from "@autonomos/core";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useUndoableTextValue } from "../hooks/useUndoableTextValue";
import { THEMES, useStore } from "../store";

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
 */

// ── Types ────────────────────────────────────────────────────────

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

type PanelMode =
  | { kind: "list" }
  | { kind: "edit"; name: string; existing: boolean };

const ALL_CAPABILITIES: AgentCapability[] = [
  "send",
  "list_agents",
  "create_agent",
  "kill_agent",
];

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

// ── Card ─────────────────────────────────────────────────────────

interface TemplateCardProps {
  name: string;
  template: AgentTemplate;
  runningCount: number;
  page: PageTheme;
  onEdit: () => void;
}

function TemplateCard({
  name,
  template,
  runningCount,
  page,
  onEdit,
}: TemplateCardProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: card with nested buttons
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onEdit()}
      className="text-left cursor-pointer transition-all duration-200 relative group"
      style={{
        background: "rgba(28, 36, 51, 0.6)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        padding: "16px 18px",
        minWidth: 240,
        maxWidth: 320,
      }}
    >
      {/* Accent line */}
      <div
        className="absolute top-0 left-3 right-3 h-[2px] rounded-full"
        style={{
          background:
            runningCount > 0
              ? "linear-gradient(90deg, #22c55e, #10b981)"
              : "rgba(255,255,255,0.08)",
        }}
      />

      {/* Header row */}
      <div className="flex items-start gap-2 mb-2">
        <div className="flex-1 min-w-0">
          <div
            className="text-[14px] font-semibold tracking-tight truncate"
            style={{ color: "#e6e1cf" }}
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

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-[10px]" style={{ color: page.statusFg }}>
          {template.capabilities.length} capabilities
        </span>
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
  onEdit: (name: string) => void;
  onNew: () => void;
}

function ListView({
  templates,
  loading,
  error,
  page,
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
            style={{ color: "#e6e1cf" }}
          >
            Templates
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: page.statusFg }}>
            Blueprints for spawning agents — role, system prompt, and
            capabilities
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
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            }}
          >
            {names.map((name) => (
              <TemplateCard
                key={name}
                name={name}
                template={templates[name]}
                runningCount={runningCounts[name] ?? 0}
                page={page}
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
  onCancel: () => void;
  onSaved: () => void;
}

function EditorView({
  name: initialName,
  existing,
  template,
  page,
  onCancel,
  onSaved,
}: EditorViewProps) {
  const runningCounts = useRunningAgentsByTemplate();
  const runningCount = runningCounts[initialName] ?? 0;
  const { saveTemplate, deleteTemplate } = useStore(
    useShallow((s) => ({
      saveTemplate: s.saveTemplate,
      deleteTemplate: s.deleteTemplate,
    })),
  );

  const [name, setName] = useState(initialName);
  const [role, setRole] = useState(template?.role ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(
    template?.systemPrompt ?? "",
  );
  // Restore Cmd/Ctrl+Z undo for the controlled System Prompt textarea —
  // React's value replacement wipes the browser's native undo stack.
  const systemPromptUndo = useUndoableTextValue(systemPrompt, setSystemPrompt);
  const [capabilities, setCapabilities] = useState<AgentCapability[]>(
    template?.capabilities ?? [...ALL_CAPABILITIES],
  );
  const [autonomousMode, setAutonomousMode] = useState(
    template?.autonomousMode ?? true,
  );
  const [model, setModel] = useState(template?.model ?? "");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleCapability = (cap: AgentCapability) => {
    setCapabilities((current) =>
      current.includes(cap)
        ? current.filter((c) => c !== cap)
        : [...current, cap],
    );
  };

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
      const payload: AgentTemplate = {
        role: role.trim(),
        description: description.trim(),
        systemPrompt,
        capabilities,
        autonomousMode,
        ...(model.trim() ? { model: model.trim() } : {}),
      };
      await saveTemplate(name.trim(), payload);
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
      await deleteTemplate(initialName);
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
            background: "rgba(255,255,255,0.06)",
          }}
          title="Back to templates"
        >
          ← Back
        </button>
        <div className="flex-1 min-w-0">
          <h2
            className="text-[15px] font-semibold tracking-tight truncate"
            style={{ color: "#e6e1cf" }}
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
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
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
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
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
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
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
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
                minHeight: 180,
              }}
            />
          </Field>

          {/* Capabilities */}
          <Field label="Capabilities">
            <div className="grid grid-cols-2 gap-2">
              {ALL_CAPABILITIES.map((cap) => {
                const checked = capabilities.includes(cap);
                return (
                  <label
                    key={cap}
                    className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded"
                    style={{
                      background: checked
                        ? "rgba(34,197,94,0.1)"
                        : "rgba(0,0,0,0.2)",
                      border: `1px solid ${checked ? "rgba(34,197,94,0.3)" : page.border}`,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCapability(cap)}
                      className="cursor-pointer"
                    />
                    <span
                      className="text-[12px] font-mono"
                      style={{ color: "#e6e1cf" }}
                    >
                      {cap}
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>

          {/* Autonomous mode */}
          <Field label="">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autonomousMode}
                onChange={(e) => setAutonomousMode(e.target.checked)}
                className="cursor-pointer"
              />
              <span className="text-[12px]" style={{ color: "#e6e1cf" }}>
                Autonomous mode{" "}
                <span style={{ color: page.statusFg }}>
                  (skip permission prompts)
                </span>
              </span>
            </label>
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
                background: "rgba(0,0,0,0.3)",
                border: `1px solid ${page.border}`,
                color: "#e6e1cf",
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
                background: "rgba(255,255,255,0.06)",
                color: "#e6e1cf",
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
                        background: "rgba(255,255,255,0.06)",
                        color: "#e6e1cf",
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
  const templates = useStore((s) => s.templates);
  const templatesLoading = useStore((s) => s.templatesLoading);
  const templatesError = useStore((s) => s.templatesError);
  const fetchTemplates = useStore((s) => s.fetchTemplates);

  const [mode, setMode] = useState<PanelMode>({ kind: "list" });

  // Initial fetch + poll every 10s so running counts stay fresh
  useEffect(() => {
    fetchTemplates();
    const interval = setInterval(fetchTemplates, 10000);
    return () => clearInterval(interval);
  }, [fetchTemplates]);

  const handleSaved = () => {
    setMode({ kind: "list" });
    fetchTemplates();
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
          onEdit={(name) => setMode({ kind: "edit", name, existing: true })}
          onNew={() => setMode({ kind: "edit", name: "", existing: false })}
        />
      ) : (
        <EditorView
          name={mode.name}
          existing={mode.existing}
          template={mode.existing ? templates[mode.name] : undefined}
          page={page}
          onCancel={() => setMode({ kind: "list" })}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

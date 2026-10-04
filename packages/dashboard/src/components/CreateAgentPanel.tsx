import {
  completePermission,
  type Provider,
  type ProviderInfo,
  type RuntimePermission,
} from "@autonomos/core";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { providersApi } from "../api/misc";
import { presetsPoll, templatesPoll } from "../api/polls";
import { usePoll } from "../api/usePoll";
import { THEMES, useStore } from "../store";
import {
  knownDefault,
  PERMISSION_RUNTIMES,
  PermissionChip,
  PermissionNotes,
  RUNTIME_NAMES,
  RuntimeAxisFields,
  templatePin,
  unknownDefaultText,
  useRuntimeDefaults,
} from "./RuntimePermission";

export function CreateAgentPanel() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const { projects, createSession, status, fetchProjects } = useStore(
    useShallow((s) => ({
      projects: s.projects,
      createSession: s.createSession,
      status: s.status,
      fetchProjects: s.fetchProjects,
    })),
  );
  // Shared polls, not a mount-time store fetch: a template/preset created in
  // a side-by-side panel shows up here within one 10s cycle instead of never.
  const templates = usePoll(templatesPoll).data ?? {};
  const presets = usePoll(presetsPoll).data ?? {};

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [name, setName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  // Default the template to Dispatcher since it's the typical "first agent
  // to spawn." Auto-default flips OFF the moment the user picks any template
  // (including None) so we never override an explicit choice on later renders
  // (e.g. when templates re-fetch and the effect would otherwise re-fire).
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [autoDefaulted, setAutoDefaulted] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("claude-code");
  // Optional model-override env preset applied at spawn (empty = default backend).
  const [selectedPreset, setSelectedPreset] = useState("");
  // The operator's per-runtime defaults (Settings → Runtimes, server-side).
  const runtimeDefaults = useRuntimeDefaults();
  // Permissions picked HERE, per runtime. Only these are sent: an untouched
  // form says nothing, and the server resolves template pin → your default.
  const [picked, setPicked] = useState<
    Partial<Record<Provider, RuntimePermission>>
  >({});
  const [selectedDir, setSelectedDir] = useState("~");
  const [customDir, setCustomDir] = useState("");
  const [showCustomDir, setShowCustomDir] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBusy = status === "spawning..." || status === "resuming...";

  useEffect(() => {
    providersApi
      .list()
      .then((data) => setProviders(data))
      .catch(() => {});
    fetchProjects();
  }, [fetchProjects]);

  // Auto-select Dispatcher on first render where templates include it AND
  // the user hasn't already chosen something. Only runs once thanks to
  // `autoDefaulted` — explicit user picks (including None) won't be
  // overridden later when templates re-fetch.
  useEffect(() => {
    if (autoDefaulted) return;
    if (selectedTemplate !== null) return;
    if (!templates.dispatcher) return;
    setSelectedTemplate("dispatcher");
    setAutoDefaulted(true);
    if (!nameManuallyEdited) {
      const role = templates.dispatcher.role || "dispatcher";
      setName(role.charAt(0).toUpperCase() + role.slice(1));
    }
  }, [templates, selectedTemplate, autoDefaulted, nameManuallyEdited]);

  const templateList = Object.entries(templates);
  // Move Dispatcher to the front of the picker so the recommendation is the
  // first option after "None".
  templateList.sort(([a], [b]) => {
    if (a === "dispatcher") return -1;
    if (b === "dispatcher") return 1;
    return 0;
  });

  const knownDirs = projects
    .map((p) => ({
      path: p.path,
      name: p.name,
      sessionCount: p.sessions.length,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, 8);

  function selectTemplate(tname: string | null) {
    setSelectedTemplate(tname);
    // Explicit user pick — even if it's None, lock out the Dispatcher
    // auto-default for the rest of this panel's lifetime.
    setAutoDefaulted(true);
    // A new template brings its own pins: drop picks made for the old one.
    setPicked({});
    if (!nameManuallyEdited) {
      if (tname && templates[tname]) {
        const role = templates[tname].role || tname;
        setName(role.charAt(0).toUpperCase() + role.slice(1));
      } else {
        setName("");
      }
    }
  }

  async function handleCreate() {
    setError(null);
    if (!name.trim()) {
      setError("Agent name is required");
      return;
    }
    const dir = showCustomDir ? customDir : selectedDir;
    if (!dir) {
      setError("Please select a working directory");
      return;
    }

    try {
      const tmpl = selectedTemplate ? templates[selectedTemplate] : null;

      await createSession(dir, {
        name: name || undefined,
        provider: selectedProvider,
        template: selectedTemplate || undefined,
        appendSystemPrompt: tmpl?.systemPrompt,
        permission: picked[selectedProvider as Provider]?.values,
        envPreset: selectedPreset || undefined,
      });
      // spawnSession's onSuccess switchPanes to the new agent, which solo-
      // replaces this create-agent panel — no explicit close needed.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    }
  }

  return (
    <div
      className="flex flex-col flex-1 h-full w-full"
      style={{ background: page.bg, color: page.fg }}
    >
      {/* Header */}
      <div
        className="shrink-0 px-6 py-4 border-b"
        style={{ borderColor: page.border }}
      >
        <h2 className="text-lg font-semibold">Create New Agent</h2>
        <p className="text-xs mt-1" style={{ color: page.statusFg }}>
          Configure and spawn a new coding agent
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Name */}
        <Section
          title="Name"
          required
          subtitle="Display name for this agent"
          page={page}
        >
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameManuallyEdited(true);
            }}
            placeholder="e.g. Dispatcher, Researcher"
            className="w-full max-w-md px-3 py-2 rounded text-sm"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: `1px solid ${page.border}`,
              color: page.fg,
            }}
          />
        </Section>

        {/* Template */}
        <Section
          title="Template"
          subtitle="Optional role template for the agent"
          page={page}
        >
          <div className="flex items-stretch gap-3 overflow-x-auto pb-2 min-w-0">
            <SelectionCard
              selected={selectedTemplate === null}
              onClick={() => selectTemplate(null)}
              page={page}
            >
              <div className="font-medium text-sm">None</div>
              <div className="text-xs mt-1" style={{ color: page.statusFg }}>
                No template
              </div>
            </SelectionCard>
            {templateList.map(([tname, tmpl]) => (
              <SelectionCard
                key={tname}
                selected={selectedTemplate === tname}
                onClick={() => selectTemplate(tname)}
                page={page}
              >
                <div className="flex items-center gap-1.5">
                  <div className="font-medium text-sm">
                    {tmpl.role || tname}
                  </div>
                  {tname === "dispatcher" && (
                    <span
                      className="text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded"
                      style={{
                        background: "rgba(35,134,54,0.25)",
                        color: "#91b362",
                      }}
                    >
                      Recommended
                    </span>
                  )}
                </div>
                <div
                  className="text-[10px] font-mono mt-0.5"
                  style={{ color: page.statusFg }}
                >
                  {tname}
                </div>
                <div
                  className="text-xs mt-1 line-clamp-2"
                  style={{ color: page.statusFg }}
                >
                  {tmpl.description}
                </div>
              </SelectionCard>
            ))}
          </div>
        </Section>

        {/* Runtime */}
        <Section
          title="Runtime"
          subtitle="Which coding agent CLI to use"
          page={page}
        >
          <div className="flex items-stretch gap-3 overflow-x-auto pb-2 min-w-0">
            {providers.map((p) => (
              <RuntimeCard
                key={p.name}
                provider={p}
                selected={selectedProvider === p.name}
                onClick={() => p.installed && setSelectedProvider(p.name)}
                page={page}
              />
            ))}
            {providers.length === 0 && (
              <div className="text-xs" style={{ color: page.statusFg }}>
                Loading providers...
              </div>
            )}
          </div>
        </Section>

        {/* Permissions */}
        <Section
          title="Permissions"
          subtitle="In the runtime's own values. The one marked default comes from Settings → Runtimes."
          page={page}
        >
          {PERMISSION_RUNTIMES.includes(selectedProvider as Provider) && (
            <PermissionPicker
              runtime={selectedProvider as Provider}
              picked={picked[selectedProvider as Provider]}
              pin={templatePin(
                selectedTemplate ? templates[selectedTemplate] : null,
                selectedProvider as Provider,
              )}
              templateName={selectedTemplate}
              defaultPermission={knownDefault(
                runtimeDefaults,
                selectedProvider as Provider,
              )}
              defaultUnknown={unknownDefaultText(runtimeDefaults)}
              onPick={(p) => setPicked((cur) => ({ ...cur, [p.runtime]: p }))}
              page={page}
            />
          )}
        </Section>

        {/* Model Override Preset */}
        <Section
          title="Model Override"
          subtitle="Optional env preset applied at spawn (e.g. an alternate model backend)"
          page={page}
        >
          <select
            value={selectedPreset}
            onChange={(e) => setSelectedPreset(e.target.value)}
            className="w-full max-w-md px-3 py-2 rounded text-sm cursor-pointer"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: `1px solid ${page.border}`,
              color: page.fg,
            }}
          >
            <option value="">None (default backend)</option>
            {Object.values(presets).map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.label
                  ? `${preset.label} (${preset.name})`
                  : preset.name}
              </option>
            ))}
          </select>
        </Section>

        {/* Working Directory */}
        <Section
          title="Working Directory"
          subtitle="Where the agent will run"
          page={page}
        >
          <div className="flex items-stretch gap-3 flex-wrap pb-2">
            <SelectionCard
              selected={!showCustomDir && selectedDir === "~"}
              onClick={() => {
                setSelectedDir("~");
                setShowCustomDir(false);
              }}
              page={page}
            >
              <div className="font-medium text-sm">Home (~)</div>
              <div className="text-xs mt-1" style={{ color: page.statusFg }}>
                Default
              </div>
            </SelectionCard>
            {knownDirs.map((d) => (
              <SelectionCard
                key={d.path}
                selected={!showCustomDir && selectedDir === d.path}
                onClick={() => {
                  setSelectedDir(d.path);
                  setShowCustomDir(false);
                }}
                page={page}
              >
                <div className="font-medium text-sm">{d.name}</div>
                <div
                  className="text-[10px] font-mono mt-0.5 truncate max-w-[160px]"
                  style={{ color: page.statusFg }}
                >
                  {d.path}
                </div>
                <div className="text-xs mt-1" style={{ color: page.statusFg }}>
                  {d.sessionCount} session{d.sessionCount !== 1 ? "s" : ""}
                </div>
              </SelectionCard>
            ))}
            <SelectionCard
              selected={showCustomDir}
              onClick={() => setShowCustomDir(true)}
              page={page}
            >
              <div className="font-medium text-sm">Custom...</div>
              <div className="text-xs mt-1" style={{ color: page.statusFg }}>
                Enter a path
              </div>
            </SelectionCard>
          </div>
          {showCustomDir && (
            <input
              type="text"
              value={customDir}
              onChange={(e) => setCustomDir(e.target.value)}
              placeholder="/path/to/project"
              className="mt-2 w-full max-w-md px-3 py-2 rounded text-sm"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: `1px solid ${page.border}`,
                color: page.fg,
              }}
            />
          )}
        </Section>
      </div>

      {/* Footer — always visible */}
      <div
        className="shrink-0 px-6 py-4 border-t flex items-center gap-4"
        style={{ borderColor: page.border }}
      >
        <button
          type="button"
          onClick={handleCreate}
          disabled={isBusy}
          className="px-5 py-2 rounded text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#238636", color: "#fff" }}
        >
          {isBusy ? "Creating..." : "Create Agent"}
        </button>
        {error && (
          <span className="text-xs" style={{ color: "#ea6c73" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/** What the agent will run with, and where that value comes from. */
function PermissionPicker({
  runtime,
  picked,
  pin,
  templateName,
  defaultPermission,
  defaultUnknown,
  onPick,
  page,
}: {
  runtime: Provider;
  picked: RuntimePermission | undefined;
  pin: RuntimePermission | undefined;
  templateName: string | null;
  /** Undefined while the operator's default is unknown (loading / failed):
   *  then nothing is claimed — the server spawns with the REAL default. */
  defaultPermission: RuntimePermission | undefined;
  defaultUnknown: string;
  onPick: (p: RuntimePermission) => void;
  page: { bg: string; fg: string; border: string; statusFg: string };
}) {
  const shown = picked ?? pin ?? defaultPermission;
  const from = picked
    ? "chosen here"
    : pin
      ? `pinned by the ${templateName} template`
      : `your ${RUNTIME_NAMES[runtime]} default`;
  return (
    <div className="space-y-3" data-testid="permission-picker">
      <RuntimeAxisFields
        permission={shown ?? completePermission(runtime)}
        noSelection={!shown}
        onChange={onPick}
        page={page}
        variant="cards"
        defaults={defaultPermission}
        idPrefix={`spawn-${runtime}`}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span style={{ color: page.statusFg }}>Will run as</span>
        {shown ? (
          <>
            <PermissionChip permission={shown} page={page} />
            <span className="text-[10px]" style={{ color: page.statusFg }}>
              {from}
            </span>
          </>
        ) : (
          <span data-testid="default-unknown" style={{ color: page.fg }}>
            your {RUNTIME_NAMES[runtime]} default ({defaultUnknown})
          </span>
        )}
      </div>
      {shown && (
        <div className="max-w-xl">
          <PermissionNotes permission={shown} page={page} />
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  required,
  page,
  children,
}: {
  title: string;
  subtitle?: string;
  required?: boolean;
  page: { statusFg: string };
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2">
        <h3 className="text-sm font-medium">
          {title}
          {required && <span style={{ color: "#ea6c73" }}> *</span>}
        </h3>
        {subtitle && (
          <p className="text-xs mt-0.5" style={{ color: page.statusFg }}>
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function SelectionCard({
  selected,
  onClick,
  page,
  children,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  page: { bg: string; fg: string; border: string; statusFg: string };
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 w-[180px] p-3 rounded-lg text-left cursor-pointer transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed flex flex-col justify-start"
      style={{
        background: selected
          ? "rgba(35,134,54,0.15)"
          : "rgba(255,255,255,0.04)",
        border: `1.5px solid ${selected ? "#238636" : page.border}`,
        color: page.fg,
      }}
    >
      {children}
    </button>
  );
}

function RuntimeCard({
  provider,
  selected,
  onClick,
  page,
}: {
  provider: ProviderInfo;
  selected: boolean;
  onClick: () => void;
  page: { bg: string; fg: string; border: string; statusFg: string };
}) {
  const { capabilities: caps, installed } = provider;

  const installUrls: Record<string, string> = {
    "claude-code":
      "https://docs.anthropic.com/en/docs/claude-code/getting-started",
    codex: "https://github.com/openai/codex",
    "gemini-cli": "https://github.com/google-gemini/gemini-cli",
  };

  let background = "rgba(255,255,255,0.04)";
  let borderColor = page.border;
  if (selected) {
    background = "rgba(35,134,54,0.15)";
    borderColor = "#238636";
  } else if (!installed) {
    background = "rgba(255,255,255,0.02)";
    borderColor = "rgba(255,255,255,0.08)";
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!installed}
      className="shrink-0 w-[220px] p-3 rounded-lg text-left cursor-pointer transition-all duration-150 disabled:opacity-30 disabled:cursor-not-allowed flex flex-col justify-start"
      style={{
        background,
        border: `1.5px solid ${borderColor}`,
        color: installed ? page.fg : page.statusFg,
      }}
    >
      <div className="font-medium text-sm whitespace-nowrap">
        {provider.displayName}
      </div>
      {!installed && (
        <div className="mt-2 space-y-1">
          <div className="text-xs" style={{ color: "#ea6c73" }}>
            Not installed
          </div>
          <div className="text-[10px]" style={{ color: page.statusFg }}>
            <a
              href={installUrls[provider.name] ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
              style={{ color: "#53bdfa" }}
              onClick={(e) => e.stopPropagation()}
            >
              Installation guide
            </a>
          </div>
          <div className="text-[10px]" style={{ color: page.statusFg }}>
            After installing, reopen this panel (or reload the page)
          </div>
        </div>
      )}
      {installed && (
        <div className="mt-2 space-y-0.5">
          <CapRow
            ok={caps.messaging.outbound}
            label="Message other agents"
            page={page}
          />
          <CapRow
            ok={caps.messaging.inbound}
            label="Receive agent messages"
            page={page}
          />
          <CapRow
            ok={caps.liveStatus.supported}
            label="Live status"
            page={page}
          />
          <CapRow
            ok={caps.systemPrompt.supported}
            label="Custom system prompt"
            page={page}
          />
          {caps.hooks.requiresSetup && (
            <div
              className="text-[10px] mt-1 px-1.5 py-0.5 rounded"
              style={{ background: "rgba(230,180,80,0.15)", color: "#e6b450" }}
            >
              Live status needs a one-time setup for this runtime
            </div>
          )}
          {provider.recommended && (
            <div
              className="text-[10px] mt-1 px-1.5 py-0.5 rounded"
              style={{ background: "rgba(35,134,54,0.25)", color: "#91b362" }}
            >
              Recommended with full support
            </div>
          )}
        </div>
      )}
    </button>
  );
}

function CapRow({
  ok,
  label,
  page,
}: {
  ok: boolean;
  label: string;
  page: { statusFg: string };
}) {
  return (
    <div
      className="flex items-center gap-1.5 text-[11px]"
      style={{ color: page.statusFg }}
    >
      <span style={{ color: ok ? "#91b362" : "#ea6c73" }}>
        {ok ? "✓" : "✗"}
      </span>
      <span>{label}</span>
    </div>
  );
}

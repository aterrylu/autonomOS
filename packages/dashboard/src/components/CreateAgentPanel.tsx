import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODE_INFO,
  type PermissionMode,
  type Provider,
  type ProviderCapabilities,
} from "@autonomos/core";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { THEMES, useStore } from "../store";
import { PermissionModeSelect } from "./PermissionModeSelect";

interface ProviderInfo {
  name: string;
  displayName: string;
  installed: boolean;
  version: string | null;
  recommended: boolean;
  capabilities: ProviderCapabilities;
}

export function CreateAgentPanel() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const {
    templates,
    projects,
    createSession,
    status,
    fetchProjects,
    fetchTemplates,
    defaultPermissionMode,
  } = useStore(
    useShallow((s) => ({
      templates: s.templates,
      projects: s.projects,
      createSession: s.createSession,
      status: s.status,
      fetchProjects: s.fetchProjects,
      fetchTemplates: s.fetchTemplates,
      defaultPermissionMode: s.permissionMode,
    })),
  );

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
  // Per-spawn permission mode, seeded from the global default. A template with
  // its own permissionMode overrides this when selected (see selectTemplate).
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    defaultPermissionMode,
  );
  const [selectedDir, setSelectedDir] = useState("~");
  const [customDir, setCustomDir] = useState("");
  const [showCustomDir, setShowCustomDir] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBusy = status === "spawning..." || status === "resuming...";

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((data: ProviderInfo[]) => setProviders(data))
      .catch(() => {});
    fetchProjects();
    fetchTemplates();
  }, [fetchProjects, fetchTemplates]);

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

  // Codex can't represent every mode (e.g. plan, which has no Codex equivalent).
  // If the selected provider doesn't support the current mode, fall back to the
  // safe mode so the dropdown and the eventual spawn agree — the option is also
  // disabled in the dropdown, but a provider switch can strand a prior pick.
  // Mirrors the server-side clamp in codexApprovalPolicy.
  useEffect(() => {
    if (
      PERMISSION_MODE_INFO[permissionMode].unsupportedBy?.includes(
        selectedProvider as Provider,
      )
    ) {
      setPermissionMode(DEFAULT_PERMISSION_MODE);
    }
  }, [selectedProvider, permissionMode]);

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
    // Adopt the template's default permission mode (if it declares one) so the
    // dropdown reflects what this template will spawn with; still overridable.
    const tmplMode = tname ? templates[tname]?.permissionMode : undefined;
    if (tmplMode) setPermissionMode(tmplMode);
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
        permissionMode,
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
          subtitle="How much autonomy this agent has over tool use"
          page={page}
        >
          <PermissionModeSelect
            value={permissionMode}
            onChange={setPermissionMode}
            page={page}
            provider={selectedProvider as Provider}
          />
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
            Restart server after installing
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
              Hooks require one-time setup
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

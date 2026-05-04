/**
 * AgentProvider — abstraction over agent CLI backends.
 *
 * A provider knows how to resolve its binary, build CLI args and env vars,
 * and handle provider-specific startup quirks. It does NOT manage sessions,
 * PTYs, or lifecycle — that's the job of sessions.ts.
 *
 * Claude Code is the first implementation. Codex CLI and Gemini CLI follow.
 */

/** Minimal PTY interface for the startup watcher (avoids node-pty dependency in core) */
export interface PtyHandle {
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
}

export interface AgentProvider {
  /** Provider identifier (e.g. "claude-code", "codex", "gemini-cli") */
  readonly name: string;

  /** Human-readable display name (e.g. "Claude Code", "Codex CLI") */
  readonly displayName: string;

  /**
   * Resolve the absolute path to the provider's binary.
   * Throws if not installed.
   */
  resolveBinary(): string;

  /**
   * Build the CLI arguments for spawning a session.
   * Translates generic SpawnOptions into provider-specific flags.
   */
  buildArgs(options: ResolvedSpawnOptions): string[];

  /**
   * Build the environment variables for the spawned process.
   * Includes autonomOS identification vars + provider-specific overrides.
   */
  buildEnv(sessionId: string, agentName: string): Record<string, string>;

  /**
   * Optional: attach a watcher to the PTY that handles provider-specific
   * startup prompts (e.g. CC's trust/channels prompts, Codex's sandbox warnings).
   * Called immediately after PTY spawn. The watcher should self-dispose.
   */
  attachStartupWatcher?(pty: PtyHandle, options: ResolvedSpawnOptions): void;

  /**
   * Optional: translate a native hook event into CC-shaped vocabulary so the
   * shared status derivation can consume it. Return null to drop the event
   * (e.g. streaming chunks with no lifecycle meaning). The returned object
   * must use CC event names (PreToolUse, PostToolUse, UserPromptSubmit, Stop,
   * SessionStart, SessionEnd, Notification, PermissionRequest, PreCompact,
   * PostCompact, SubagentStart, SubagentStop, PostToolUseFailure).
   */
  normalizeEvent?(raw: Record<string, unknown>): Record<string, unknown> | null;

  /**
   * Provider capabilities — what this backend supports.
   * Used by the dashboard to show feature availability.
   */
  readonly capabilities: ProviderCapabilities;
}

/** What a provider can and can't do */
export interface ProviderCapabilities {
  /** Hook event count and whether hooks need one-time setup */
  hooks: {
    eventCount: number;
    /** True if hooks are injected per-session via flags/env (no setup needed) */
    perSession: boolean;
    /** True if a one-time install is required (e.g. Codex hooks.json) */
    requiresSetup: boolean;
  };
  /** MCP channel server injection */
  mcp: {
    supported: boolean;
    /** True if MCP config is injected per-session via flags/env */
    perSession: boolean;
  };
  /** System prompt / context injection */
  systemPrompt: {
    supported: boolean;
    /** How the prompt is injected */
    method: "flag" | "prepend-to-prompt" | "none";
  };
  /** Inter-agent messaging */
  messaging: {
    /** Agent can call send() to message other agents */
    outbound: boolean;
    /** Agent can receive messages from other agents */
    inbound: boolean;
    /** How inbound delivery works (if supported) */
    inboundMethod: "channels" | "pty-injection" | "none";
  };
  /** Can pre-set session ID at spawn time */
  presetSessionId: boolean;
  /** Can resume a previous session */
  sessionResume: boolean;
  /** Can fork a session */
  sessionFork: boolean;
  /** Can set agent display name at spawn time */
  agentNaming: boolean;
}

/**
 * SpawnOptions — generic options for creating an agent session.
 * Provider-agnostic. The provider's buildArgs() translates these
 * into CLI-specific flags.
 */
export interface SpawnOptions {
  workingDirectory: string;
  prompt?: string;
  /** Display name for the session */
  name?: string;
  /** Provider session ID to resume */
  resumeSessionId?: string;
  /** Provider session ID to fork from — child inherits parent's context */
  forkFrom?: string;
  /** Skip permission prompts */
  autonomousMode?: boolean;
  /** Replace the default system prompt entirely */
  systemPrompt?: string;
  /** Append to the default system prompt */
  appendSystemPrompt?: string;
  cols?: number;
  rows?: number;
  /** Template used to spawn this agent (e.g. "team-lead") */
  template?: string;
  /** Manager agent name for org chart (e.g. "CEO@company") */
  manager?: string;
  /** Project scope (e.g. "autonomOS") */
  project?: string;
  /** Which provider to use (default: "claude-code") */
  provider?: string;
}

/**
 * ResolvedSpawnOptions — SpawnOptions after the orchestrator has resolved
 * defaults, generated IDs, and computed derived values. Passed to buildArgs().
 */
export interface ResolvedSpawnOptions extends SpawnOptions {
  /** Pre-generated session ID (autonomOS internal) */
  sessionId: string;
  /** Resolved agent display name */
  agentName: string;
  /** Resolved working directory (~ expanded) */
  cwd: string;
  /** Provider session ID (for resume/fork tracking) */
  providerSessionId: string;
  /** Whether the autonomOS channel server MCP should be injected */
  injectChannelServer: boolean;
  /** Absolute path to the channel server script */
  channelServerScript: string;
  /** autonomOS server port */
  serverPort: string;
  /** Resolved capabilities from template (for MCP capability gating) */
  capabilities: string[];
}

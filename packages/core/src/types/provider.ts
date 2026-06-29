/**
 * AgentProvider — abstraction over agent CLI backends.
 *
 * A provider knows how to resolve its binary, build CLI args and env vars,
 * and handle provider-specific startup quirks. It does NOT manage sessions,
 * PTYs, or lifecycle — that's the job of sessions.ts.
 *
 * Claude Code is the first implementation. Codex CLI and Gemini CLI follow.
 */

import type { PermissionMode } from "./permissions";

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
   * Optional: describe a sidecar daemon to start BEFORE the visible PTY.
   *
   * Some providers run a backend daemon behind the terminal (Codex's
   * `app-server`, attached via `codex --remote`). The runtime picks a free
   * loopback port, sets `options.sidecarEndpoint`, calls this to get the
   * daemon's argv, starts it, waits for `readyNeedle`, and only then spawns the
   * PTY (whose buildArgs can reference `options.sidecarEndpoint`). The daemon is
   * disposed when the PTY exits. The daemon binary is `resolveBinary()`.
   *
   * Return null to spawn no sidecar (legacy in-process behavior).
   */
  buildSidecar?(options: ResolvedSpawnOptions): SidecarSpec | null;

  /**
   * Optional: attach a watcher to the PTY that handles provider-specific
   * startup prompts (e.g. CC's trust/channels prompts, Codex's sandbox warnings).
   * Called immediately after PTY spawn. The watcher should self-dispose.
   */
  attachStartupWatcher?(pty: PtyHandle, options: ResolvedSpawnOptions): void;

  /**
   * Optional: does a RESUMABLE session actually exist on disk for these options?
   *
   * The runtime calls this on the resume path BEFORE building args. When it
   * returns false, the runtime spawns a FRESH session (reusing the same
   * providerSessionId) instead of emitting the provider's resume flags —
   * preventing a doomed resume from crashing the agent and dropping it out of
   * the dashboard.
   *
   * Motivating case: Claude Code writes its session JSONL lazily (on the first
   * turn, not at session creation), so an agent that hasn't conversed yet has
   * no `--resume` target. Codex handles this internally (a missing thread id
   * means a fresh `--remote` thread), so it does NOT implement this hook.
   *
   * Providers that omit this hook are treated as "always resumable" — the
   * runtime keeps its prior unconditional resume behavior for them.
   */
  hasResumableSession?(options: ResolvedSpawnOptions): boolean;

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

/**
 * SidecarSpec — describes a backend daemon the runtime starts before the PTY.
 * The daemon binary is the provider's `resolveBinary()`; only the argv and the
 * readiness signal differ per provider.
 */
export interface SidecarSpec {
  /** argv for the daemon (e.g. ["app-server", "--listen", "ws://127.0.0.1:PORT", ...]) */
  args: string[];
  /** Substring on the daemon's stdout/stderr that signals it is listening. */
  readyNeedle: string;
  /** Max ms to wait for readiness before failing the spawn. Default 12000. */
  readyTimeoutMs?: number;
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
  /** Live busy/idle status reporting. Decoupled from `hooks` because not every
   *  provider sources status from a hook relay — Codex derives status from its
   *  app-server event stream, so it reports live status with zero hook events. */
  liveStatus: {
    supported: boolean;
    /** Where status comes from when supported. */
    method: "hooks" | "event-stream" | "none";
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
  /** How much autonomy the agent has over tool use (maps to provider-native
   *  permission flags). Replaces the old `autonomousMode: boolean`. */
  permissionMode?: PermissionMode;
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
  /**
   * ws:// endpoint of the provider's sidecar daemon, set by the runtime before
   * buildSidecar/buildArgs when the provider declares buildSidecar. The daemon
   * listens here (`--listen`) and the PTY/gateway connect here (`--remote`).
   */
  sidecarEndpoint?: string;

  /**
   * Codex only: the persisted conversation thread id to resume. Set by the
   * runtime when re-spawning an agent that previously captured a thread, so the
   * provider can emit `codex resume <threadId> --remote` instead of a fresh
   * `--remote` (which would fork a new, empty thread). Undefined on first spawn.
   */
  providerThreadId?: string;
}

/**
 * Codex CLI provider — translates generic SpawnOptions into Codex-specific
 * CLI flags, env vars, and startup handling.
 *
 * Codex runs in a per-agent DAEMON topology so it can support terminal-preserving
 * inter-agent comm (the native equivalent of Claude Code "channels"):
 *
 *   - buildSidecar() describes a `codex app-server --listen ws://127.0.0.1:PORT`
 *     daemon. The daemon owns the live thread, the system prompt (`-c
 *     instructions`), and the MCP channel server (`-c mcp_servers.autonomos`).
 *   - buildArgs() spawns the VISIBLE TUI as `codex --remote ws://…`, a thin
 *     client of that daemon. The runtime picks the port (options.sidecarEndpoint),
 *     starts the daemon, waits for it to listen, then spawns this TUI.
 *   - The gateway opens a second JSON-RPC client to the same daemon and injects
 *     inbound messages via `turn/start` — the daemon broadcasts them to every
 *     subscriber, so they render inline in the live TUI.
 *
 * Key differences from Claude Code:
 * - System prompt via `-c 'instructions="..."'` (not --append-system-prompt)
 * - MCP via `-c 'mcp_servers...'` on the DAEMON (not --mcp-config on the TUI)
 * - Status derives from the daemon's turn/* event stream (Codex has no hook relay)
 * - No --session-id, --name, or --brief flags
 */

import {
  type AgentProvider,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type ResolvedSpawnOptions,
  type SidecarSpec,
} from "@autonomos/core";
import { getConfigDir } from "../configDir.js";
import { getAuthToken } from "../serverState.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  resolveBinaryFromCandidates,
} from "./shared.js";

const binaryCache = { path: null as string | null };

/**
 * Map the common permission mode → Codex `approval_policy` value.
 *
 * Codex's two-axis model (approval + sandbox) is effectively one axis here:
 * the sandbox is always `danger-full-access` (autonomOS is the trust boundary).
 * Codex has no plan mode — `plan` is clamped to the default policy. The clamp
 * warning lives in daemonConfigArgs (called once per spawn) so it doesn't
 * double-log across the daemon + TUI layers.
 */
function codexApprovalPolicy(
  mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): string {
  switch (mode) {
    case "bypass":
      return "never";
    case "auto":
      return "on-failure";
    default:
      // "ask" and the clamped "plan" both prompt before acting.
      return "on-request";
  }
}

/**
 * Map the common permission mode → Codex `mcp_servers.<name>.default_tools_approval_mode`.
 *
 * SEPARATE axis from `approval_policy` (which gates shell/exec): this governs
 * whether the model must get user approval before calling an MCP *tool*. Codex's
 * default when the key is ABSENT is `auto`, whose heuristic prompts for any tool
 * that doesn't declare `readOnlyHint`/non-destructive annotations — so our 19
 * un-annotated channel-server tools ALL prompt, once per session. That is the
 * recurring "approve the autonomOS MCP server" gate.
 *
 * The mapping is deliberately mode-aware, mirroring the trust the permission mode
 * already grants for shell:
 *   - bypass / auto → "approve": never prompt (the agent is already autonomous).
 *   - ask / plan    → "writes": prompt only for MUTATING tools; a tool that
 *     declares `readOnlyHint: true` (see the annotated read-only tools in
 *     mcp/tools.ts) is auto-approved even under `writes`. So a supervised agent
 *     still gets asked before kill_agent / delete_* but not before list_agents.
 * `plan` has no Codex equivalent and is clamped to ask-equivalent behavior here,
 * consistent with codexApprovalPolicy.
 */
function codexMcpApprovalMode(
  mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): string {
  switch (mode) {
    case "bypass":
    case "auto":
      return "approve";
    default:
      // "ask" and the clamped "plan": prompt for mutations, auto-approve
      // read-only (readOnlyHint) tools.
      return "writes";
  }
}

/** Bypass is the all-in-one skip flag (and the resolved default when unset). */
function isBypassMode(mode: PermissionMode | undefined): boolean {
  return (mode ?? DEFAULT_PERMISSION_MODE) === "bypass";
}

/** Daemon `-c` config flags shared by the app-server: system prompt + MCP. */
function daemonConfigArgs(options: ResolvedSpawnOptions): string[] {
  const args: string[] = [];

  // System prompt / BASE_CONTEXT — lives on the daemon so every thread inherits it.
  const systemPrompt = buildSystemPrompt(
    options.systemPrompt,
    options.appendSystemPrompt,
  );
  args.push("-c", `instructions=${JSON.stringify(systemPrompt)}`);

  // Sandbox: autonomOS is the trust boundary — we never want Codex's OS sandbox
  // (bubblewrap on Linux, Seatbelt on macOS). Disable it ALWAYS, both autonomous
  // and supervised. This MUST be set on BOTH the daemon (which executes tools,
  // here) AND the --remote TUI (which creates the thread — see buildArgs);
  // setting it on only one layer loses to the other's default (workspace-write
  // → "could not find bubblewrap on PATH"). Verified on Linux.
  args.push("-c", `sandbox_mode="danger-full-access"`);

  // Approval gating is separate from sandboxing: the permission mode maps to a
  // Codex approval_policy (bypass→never, auto→on-failure, ask/plan→
  // on-request). The TUI flag in buildArgs is the primary control; this
  // daemon-side policy backs it for gateway-injected turns that share the
  // same thread. Codex has no plan mode — warn once here when we clamp it.
  if (options.permissionMode === "plan") {
    console.warn(
      "[codex] permission mode 'plan' has no Codex equivalent — clamping to " +
        "'ask' (approval_policy=on-request). Sandbox stays " +
        "danger-full-access (autonomOS is the trust boundary). NOTE: the " +
        "agent's record still says 'plan' — it reflects what was requested, " +
        "not this clamp.",
    );
  }
  args.push(
    "-c",
    `approval_policy=${JSON.stringify(codexApprovalPolicy(options.permissionMode))}`,
  );

  // MCP channel server — attached to the DAEMON (it hosts the thread + MCP),
  // giving the Codex model outbound send() + org tools, same as Claude Code.
  if (options.injectChannelServer) {
    args.push(
      "-c",
      `mcp_servers.autonomos.command="node"`,
      "-c",
      `mcp_servers.autonomos.args=${JSON.stringify([options.channelServerScript])}`,
      // Pre-approve our own tools per the permission mode — otherwise Codex's
      // `auto` default prompts once per session for the un-annotated tool set
      // (the recurring "approve the autonomOS MCP server" gate). Set on the
      // DAEMON because the daemon hosts the MCP client and makes the approval
      // decision; the --remote TUI never injects mcp_servers.
      "-c",
      `mcp_servers.autonomos.default_tools_approval_mode=${JSON.stringify(codexMcpApprovalMode(options.permissionMode))}`,
      "-c",
      // Gateway on the internal socket (ADR-055 PR B); REST base stays public.
      `mcp_servers.autonomos.env.AUTONOMOS_SERVER_URL=${JSON.stringify(`ws+unix://${options.socketPath}:/ws/gateway`)}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_API_URL=${JSON.stringify(options.apiUrl)}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_SESSION_ID=${JSON.stringify(options.sessionId)}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_AGENT_NAME=${JSON.stringify(options.agentName)}`,
      // CONFIG_DIR lets the channel server derive its per-session token-file path
      // (<configDir>/agent-tokens/<sessionId>). The token itself is NOT passed as
      // a `-c` flag: codex writes argv to world-readable /proc/<pid>/cmdline and
      // logs it, so the token would leak. The channel server reads it from the
      // 0600 file instead (ADR-055 follow-up).
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_CONFIG_DIR=${JSON.stringify(getConfigDir())}`,
      // Forward the in-process auth token (server may have booted without
      // AUTONOMOS_TOKEN in env; reading process.env would leave it tokenless
      // and rejected by /ws/* auth).
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_TOKEN=${JSON.stringify(getAuthToken())}`,
    );
  }

  return args;
}

export const codexProvider: AgentProvider = {
  name: "codex",
  displayName: "Codex CLI",

  capabilities: {
    // Status derives from the app-server event stream, not a hook relay.
    hooks: { eventCount: 0, perSession: false, requiresSetup: false },
    liveStatus: { supported: true, method: "event-stream" },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "flag" },
    // Native terminal-preserving inbound via app-server turn/start broadcast.
    messaging: { outbound: true, inbound: true, inboundMethod: "channels" },
    presetSessionId: false,
    sessionResume: true,
    sessionFork: true,
    agentNaming: false,
  },

  resolveBinary(): string {
    return resolveBinaryFromCandidates(
      "codex",
      commonBinaryCandidates("codex"),
      binaryCache,
    );
  },

  /** The per-agent `codex app-server --listen ws://…` daemon. */
  buildSidecar(options: ResolvedSpawnOptions): SidecarSpec | null {
    if (!options.sidecarEndpoint) return null;
    return {
      args: [
        "app-server",
        "--listen",
        options.sidecarEndpoint,
        ...daemonConfigArgs(options),
      ],
      // The daemon prints "listening on: ws://127.0.0.1:PORT" once bound.
      readyNeedle: "listening on",
    };
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    // Daemon model: the visible TUI is a thin client of the sidecar daemon.
    if (options.sidecarEndpoint) {
      // Conversation resume: a fresh `--remote` always forks a NEW empty thread,
      // so to restore a prior conversation across a server/daemon restart we use
      // `codex resume <threadId> --remote <ep>` — this reattaches the persisted
      // rollout (full history + memory) through the remote daemon. providerThreadId
      // is set only when this agent previously captured a thread (a respawn);
      // first spawns have none and create a fresh thread.
      const args = options.providerThreadId
        ? [
            "resume",
            options.providerThreadId,
            "--remote",
            options.sidecarEndpoint,
          ]
        : ["--remote", options.sidecarEndpoint];
      // The TUI creates/owns the thread, so ITS sandbox/approval flags govern the
      // thread (the daemon-side -c is necessary but not sufficient — both layers
      // must say danger-full-access or Codex falls back to workspace-write and
      // wants bubblewrap). bypass: skip approvals + sandbox in one flag (the CC
      // --dangerously-skip-permissions equivalent). Otherwise: drop the sandbox
      // only and set the approval_policy granularity (matches the daemon).
      if (isBypassMode(options.permissionMode)) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("-s", "danger-full-access");
        args.push(
          "-c",
          `approval_policy=${JSON.stringify(codexApprovalPolicy(options.permissionMode))}`,
        );
      }
      if (options.prompt) args.push(options.prompt);
      return args;
    }

    // Legacy fallback (no sidecar): in-process TUI carrying its own config.
    // daemonConfigArgs already sets sandbox + approval_policy for every mode;
    // bypass additionally gets the all-in-one skip flag.
    const args: string[] = [];
    if (isBypassMode(options.permissionMode)) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push("--cd", options.cwd, ...daemonConfigArgs(options));
    if (options.prompt) args.push(options.prompt);
    return args;
  },

  buildEnv(sessionId: string, agentName: string): Record<string, string> {
    return buildBaseEnv(sessionId, agentName);
  },

  // Codex doesn't have trust/channels prompts like CC,
  // so no attachStartupWatcher needed
};

export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}

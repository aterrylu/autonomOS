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

import type {
  AgentProvider,
  ResolvedSpawnOptions,
  SidecarSpec,
} from "@autonomos/core";
import { getAuthToken } from "../serverState.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  resolveBinaryFromCandidates,
} from "./shared.js";

const binaryCache = { path: null as string | null };

/** Daemon `-c` config flags shared by the app-server: system prompt + MCP. */
function daemonConfigArgs(options: ResolvedSpawnOptions): string[] {
  const args: string[] = [];

  // System prompt / BASE_CONTEXT — lives on the daemon so every thread inherits it.
  const systemPrompt = buildSystemPrompt(
    options.systemPrompt,
    options.appendSystemPrompt,
  );
  args.push("-c", `instructions=${JSON.stringify(systemPrompt)}`);

  // Autonomous mode: app-server has no --dangerously-bypass flag; configure the
  // thread defaults via `-c` so the daemon-hosted thread auto-approves.
  if (options.autonomousMode) {
    args.push(
      "-c",
      `approval_policy="never"`,
      "-c",
      `sandbox_mode="danger-full-access"`,
    );
  }

  // MCP channel server — attached to the DAEMON (it hosts the thread + MCP),
  // giving the Codex model outbound send() + org tools, same as Claude Code.
  if (options.injectChannelServer) {
    args.push(
      "-c",
      `mcp_servers.autonomos.command="node"`,
      "-c",
      `mcp_servers.autonomos.args=${JSON.stringify([options.channelServerScript])}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_SERVER_URL=${JSON.stringify(`ws://localhost:${options.serverPort}/ws/gateway`)}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_SESSION_ID=${JSON.stringify(options.sessionId)}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_AGENT_NAME=${JSON.stringify(options.agentName)}`,
      "-c",
      `mcp_servers.autonomos.env.AUTONOMOS_CAPABILITIES=${JSON.stringify(options.capabilities.join(","))}`,
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
      const args = ["--remote", options.sidecarEndpoint];
      if (options.prompt) args.push(options.prompt);
      return args;
    }

    // Legacy fallback (no sidecar): in-process TUI carrying its own config.
    const args: string[] = [];
    if (options.autonomousMode) {
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

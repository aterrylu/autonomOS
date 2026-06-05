/**
 * Codex CLI provider — translates generic SpawnOptions into
 * Codex-specific CLI flags, env vars, and startup handling.
 *
 * Key differences from Claude Code:
 * - System prompt via `-c 'instructions="..."'` (not --append-system-prompt)
 * - MCP via `-c 'mcp_servers...'` (not --mcp-config)
 * - No hook mechanism today. The `codex_hooks` feature flag is "under
 *   development" per `codex features list` and has no user-facing config
 *   surface. Codex agents run but do not emit lifecycle events to the
 *   autonomOS hook endpoint. Real integration would go through
 *   `codex app-server --listen ws://` (JSON-RPC WebSocket) — deferred.
 * - No --session-id, --name, or --brief flags
 * - Auto mode via --dangerously-bypass-approvals-and-sandbox
 */

import type { AgentProvider, ResolvedSpawnOptions } from "@autonomos/core";
import { getAuthToken } from "../serverState.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  resolveBinaryFromCandidates,
} from "./shared.js";

const binaryCache = { path: null as string | null };

export const codexProvider: AgentProvider = {
  name: "codex",
  displayName: "Codex CLI",

  capabilities: {
    // No hook mechanism in Codex today — agents are status-blind.
    hooks: { eventCount: 0, perSession: false, requiresSetup: false },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "flag" },
    messaging: { outbound: true, inbound: false, inboundMethod: "none" },
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

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    // Auto mode
    if (options.autonomousMode) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    // Working directory
    args.push("--cd", options.cwd);

    // System prompt via -c instructions
    const systemPrompt = buildSystemPrompt(
      options.systemPrompt,
      options.appendSystemPrompt,
    );
    args.push("-c", `instructions=${JSON.stringify(systemPrompt)}`);

    // MCP channel server via -c mcp_servers
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
      );

      // Forward the in-process auth token (set at server boot from
      // resolveAuthToken(), which falls back to ~/.autonomos/token on disk).
      // Reading from `process.env.AUTONOMOS_TOKEN` would be undefined when the
      // server booted without that env var set, leaving the channel server
      // tokenless and rejected by /ws/* auth.
      args.push(
        "-c",
        `mcp_servers.autonomos.env.AUTONOMOS_TOKEN=${JSON.stringify(getAuthToken())}`,
      );
    }

    // User prompt (positional arg for interactive mode)
    if (options.prompt) {
      args.push(options.prompt);
    }

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

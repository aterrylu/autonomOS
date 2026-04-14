/**
 * Codex CLI provider — translates generic SpawnOptions into
 * Codex-specific CLI flags, env vars, and startup handling.
 *
 * Key differences from Claude Code:
 * - System prompt via `-c 'instructions="..."'` (not --append-system-prompt)
 * - MCP via `-c 'mcp_servers...'` (not --mcp-config)
 * - Hooks are file-based (~/.codex/hooks.json), activated via --enable codex_hooks
 * - No --session-id, --name, or --brief flags
 * - Auto mode via --dangerously-bypass-approvals-and-sandbox
 */

import type { AgentProvider, ResolvedSpawnOptions } from "@autonomos/core";
import {
  buildBaseEnv,
  buildSystemPrompt,
  resolveBinaryFromCandidates,
} from "./shared.js";

const binaryCache = { path: null as string | null };

export const codexProvider: AgentProvider = {
  name: "codex",
  displayName: "Codex CLI",

  capabilities: {
    hooks: { eventCount: 5, perSession: false, requiresSetup: true },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "flag" },
    messaging: { outbound: true, inbound: false, inboundMethod: "none" },
    presetSessionId: false,
    sessionResume: true,
    sessionFork: true,
    agentNaming: false,
  },

  resolveBinary(): string {
    const home = process.env.HOME;
    return resolveBinaryFromCandidates(
      "codex",
      [
        ...(home ? [`${home}/.local/bin/codex`] : []),
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
      ],
      binaryCache,
    );
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    // Activate hooks (feature-flagged off by default in Codex)
    args.push("--enable", "codex_hooks");

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

      if (process.env.AUTONOMOS_TOKEN) {
        args.push(
          "-c",
          `mcp_servers.autonomos.env.AUTONOMOS_TOKEN=${JSON.stringify(process.env.AUTONOMOS_TOKEN)}`,
        );
      }
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

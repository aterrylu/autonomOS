/**
 * Gemini CLI provider — translates generic SpawnOptions into
 * Gemini-specific CLI flags, env vars, and startup handling.
 *
 * Key differences from Claude Code:
 * - Hooks + MCP via GEMINI_CLI_SYSTEM_SETTINGS_PATH env var → ~/.autonomos/gemini-settings.json
 * - System prompt prepended to user prompt (no --append-system-prompt equivalent)
 * - Auto mode via --approval-mode yolo
 * - No --session-id, --name, or --brief flags
 * - MCP servers filtered at spawn via --allowed-mcp-server-names
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, ResolvedSpawnOptions } from "@autonomos/core";
import {
  buildBaseEnv,
  buildSystemPrompt,
  HOOK_CMD,
  resolveBinaryFromCandidates,
} from "./shared.js";

const GEMINI_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "BeforeAgent",
  "AfterAgent",
] as const;

const binaryCache = { path: null as string | null };

const AUTONOMOS_CONFIG_DIR =
  process.env.AUTONOMOS_CONFIG_DIR ||
  join(process.env.HOME || "/tmp", ".autonomos");

const GEMINI_SETTINGS_PATH = join(AUTONOMOS_CONFIG_DIR, "gemini-settings.json");

export const geminiCliProvider: AgentProvider = {
  name: "gemini-cli",
  displayName: "Gemini CLI",

  capabilities: {
    hooks: { eventCount: 11, perSession: true, requiresSetup: false },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "prepend-to-prompt" },
    messaging: { outbound: true, inbound: false, inboundMethod: "none" },
    presetSessionId: false,
    sessionResume: true,
    sessionFork: false,
    agentNaming: false,
  },

  resolveBinary(): string {
    const home = process.env.HOME;
    return resolveBinaryFromCandidates(
      "gemini",
      [
        ...(home ? [`${home}/.local/bin/gemini`] : []),
        "/usr/local/bin/gemini",
        "/opt/homebrew/bin/gemini",
      ],
      binaryCache,
    );
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    // Auto mode
    if (options.autonomousMode) {
      args.push("--approval-mode", "yolo");
    }

    // Filter MCP servers to only autonomOS (if injected)
    if (options.injectChannelServer) {
      args.push("--allowed-mcp-server-names", "autonomos");
    }

    // Gemini doesn't have --append-system-prompt, so prepend system context to the user prompt.
    // Use -i (prompt-interactive) to execute the prompt then stay interactive.
    if (options.prompt) {
      const systemContext = buildSystemPrompt(
        options.systemPrompt,
        options.appendSystemPrompt,
      );
      args.push("-i", `${systemContext}\n\n---\n\n${options.prompt}`);
    }

    return args;
  },

  buildEnv(sessionId: string, agentName: string): Record<string, string> {
    const env = buildBaseEnv(sessionId, agentName);

    // Point Gemini at the autonomOS-managed settings file (hooks + MCP)
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = GEMINI_SETTINGS_PATH;

    return env;
  },

  // No startup prompts to dismiss for Gemini
};

/**
 * Write the shared Gemini settings file (~/.autonomos/gemini-settings.json).
 * Called on server startup. Contains hooks + MCP config, shared across all
 * Gemini sessions. Session differentiation via AUTONOMOS_SESSION_ID env var.
 */
export function writeGeminiSettings(channelServerScript: string): void {
  if (!existsSync(channelServerScript)) {
    console.warn(
      `[gemini-cli] Channel server script not found: ${channelServerScript} — ` +
        "Gemini agents will not have MCP tools. Run the build step first.",
    );
  }

  const port = process.env.PORT || "3000";

  const hookEntry = (timeout = 3000) => ({
    hooks: [{ type: "command", command: HOOK_CMD, timeout }],
  });

  const settings = {
    _autonomos: { version: 1 },
    hooks: {
      enabled: true,
      ...Object.fromEntries(GEMINI_HOOK_EVENTS.map((e) => [e, [hookEntry()]])),
    },
    mcpServers: {
      autonomos: {
        command: "node",
        args: [channelServerScript],
        env: {
          AUTONOMOS_SERVER_URL: `ws://localhost:${port}/ws/gateway`,
        },
      },
    },
  };

  mkdirSync(AUTONOMOS_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });
  console.log(`[gemini-cli] wrote settings to ${GEMINI_SETTINGS_PATH}`);
}

export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}

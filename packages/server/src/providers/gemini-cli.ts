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
import {
  type AgentProvider,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type ResolvedSpawnOptions,
} from "@autonomos/core";
import { getControlSocketPath } from "../internalSocket.js";
import { getServerPort } from "../serverState.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  HOOK_CMD,
  resolveBinaryFromCandidates,
} from "./shared.js";

/**
 * Gemini-native event → CC-style event name. Keys are the events we register
 * in the settings file; unmapped Gemini events are dropped by normalizeEvent.
 */
const GEMINI_TO_CC_EVENT: Record<string, string> = {
  SessionStart: "SessionStart",
  SessionEnd: "SessionEnd",
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  BeforeAgent: "UserPromptSubmit",
  AfterAgent: "Stop",
  Notification: "Notification",
};

/**
 * Gemini events we deliberately drop (no useful CC equivalent).
 * Anything outside this set that goes unmapped is flagged as possible
 * vocabulary drift in a future Gemini release.
 *  - BeforeModel / BeforeToolSelection: no status-driving CC equivalent
 *  - AfterModel: fires per streaming chunk, too noisy
 *  - PreCompress: semantic mismatch — Gemini fires this *unconditionally*
 *    on every turn (gemini-cli-core/services/chatCompressionService.ts) as
 *    a "we're checking if we should compress" hook, not "compression is
 *    starting." Mapping it to CC's PreCompact would flash the agent into
 *    "compacting" status on every message even when no compression happens.
 *    Gemini also has no PostCompress counterpart, so we can't model the
 *    state-machine pair anyway.
 */
const INTENTIONAL_DROPS = new Set([
  "BeforeModel",
  "AfterModel",
  "BeforeToolSelection",
  "PreCompress",
]);

const binaryCache = { path: null as string | null };

// ── Permission mode → Gemini --approval-mode ──────────────────
// Gemini 0.46's --approval-mode enum maps 1:1 with the common modes:
// default | auto_edit (≈auto) | plan | yolo (≈bypass).
function geminiApprovalMode(
  mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): string {
  switch (mode) {
    case "bypass":
      return "yolo";
    case "auto":
      return "auto_edit";
    case "plan":
      return "plan";
    default:
      return "default";
  }
}

const AUTONOMOS_CONFIG_DIR =
  process.env.AUTONOMOS_CONFIG_DIR ||
  join(process.env.HOME || "/tmp", ".autonomos");

const GEMINI_SETTINGS_PATH = join(AUTONOMOS_CONFIG_DIR, "gemini-settings.json");

export const geminiCliProvider: AgentProvider = {
  name: "gemini-cli",
  displayName: "Gemini CLI",

  capabilities: {
    hooks: { eventCount: 11, perSession: true, requiresSetup: false },
    liveStatus: { supported: true, method: "hooks" },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "prepend-to-prompt" },
    messaging: { outbound: true, inbound: false, inboundMethod: "none" },
    presetSessionId: false,
    sessionResume: true,
    sessionFork: false,
    agentNaming: false,
  },

  resolveBinary(): string {
    return resolveBinaryFromCandidates(
      "gemini",
      commonBinaryCandidates("gemini"),
      binaryCache,
    );
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    // Permission mode → --approval-mode (always set; "default" is Gemini's
    // own default, so this is behavior-preserving for supervised spawns).
    args.push("--approval-mode", geminiApprovalMode(options.permissionMode));

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

  normalizeEvent(raw: Record<string, unknown>): Record<string, unknown> | null {
    const nativeName = raw.hook_event_name;
    if (typeof nativeName !== "string") {
      console.warn(
        "[gemini-cli] dropping malformed hook event (no hook_event_name field)",
      );
      return null;
    }

    const mapped = GEMINI_TO_CC_EVENT[nativeName];
    if (!mapped) {
      // Unknown event names that aren't in our deliberate-drop list are
      // potential vocabulary drift signals — log loudly so we notice when
      // a new Gemini release adds an event we should map.
      if (!INTENTIONAL_DROPS.has(nativeName)) {
        console.warn(
          `[gemini-cli] dropping unknown hook event: ${nativeName} ` +
            "(possible vocabulary drift — update GEMINI_TO_CC_EVENT)",
        );
      }
      return null;
    }

    const out: Record<string, unknown> = { ...raw, hook_event_name: mapped };

    // Gemini tags permission alerts as "ToolPermission"; CC's deriveStatus
    // looks for "permission_prompt" to transition to needs_input.
    if (
      mapped === "Notification" &&
      raw.notification_type === "ToolPermission"
    ) {
      out.notification_type = "permission_prompt";
    }

    return out;
  },

  // No startup prompts to dismiss for Gemini
};

/**
 * Write the shared Gemini settings file (~/.autonomos/gemini-settings.json).
 * Contains hooks + MCP config, shared across all Gemini sessions; session
 * differentiation is via the AUTONOMOS_SESSION_ID env var.
 *
 * MUST be called AFTER the public port and the control socket are both bound
 * (see run.ts armRuntimeInits) — unlike claude-code/codex, which build per-spawn
 * args, Gemini's MCP endpoint lives in this write-once file, so it can only be
 * correct once both planes exist. Reading getServerPort() before setServerPort()
 * (the old `process.env.PORT || "3000"` fallback) is exactly the bug that baked
 * `localhost:3000` into every Gemini agent's URLs regardless of the real port.
 */
export function writeGeminiSettings(channelServerScript: string): void {
  if (!existsSync(channelServerScript)) {
    console.warn(
      `[gemini-cli] Channel server script not found: ${channelServerScript} — ` +
        "Gemini agents will not have MCP tools. Run the build step first.",
    );
  }

  // Gateway → internal socket (ws+unix); REST base → public port. Both read from
  // serverState, which is why this must run after both are published.
  const socketPath = getControlSocketPath();
  const apiUrl = `http://localhost:${getServerPort()}`;

  const hookEntry = (timeout = 3000) => ({
    hooks: [{ type: "command", command: HOOK_CMD, timeout }],
  });

  // The Gemini settings schema separates hook system toggles from event
  // arrays — `hooksConfig.enabled` (boolean) is the master switch;
  // `hooks.<EventName>` only accepts arrays of hook definitions. Putting
  // `enabled: true` inside `hooks` trips schema validation even though
  // the registry's back-compat code would have skipped it. We set
  // `hooksConfig.enabled` explicitly rather than relying on Gemini's
  // documented default — if a future release flips the default, our
  // hooks would silently stop firing and the dashboard would go blind.
  const settings = {
    _autonomos: { version: 1 },
    hooksConfig: { enabled: true },
    hooks: Object.fromEntries(
      Object.keys(GEMINI_TO_CC_EVENT).map((e) => [e, [hookEntry()]]),
    ),
    mcpServers: {
      autonomos: {
        command: "node",
        args: [channelServerScript],
        env: {
          AUTONOMOS_SERVER_URL: `ws+unix://${socketPath}:/ws/gateway`,
          AUTONOMOS_API_URL: apiUrl,
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

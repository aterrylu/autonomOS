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
import { getConfigDir } from "../configDir.js";
import { getControlSocketPath } from "../internalSocket.js";
import { getAuthToken, getServerPort } from "../serverState.js";
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

// Per-call via the guarded accessor (#350): the old module-load freeze here
// bypassed the config-dir escape guard AND handed a stale value to the MCP
// subprocess env below (#272 freeze-at-import hazard, flagged in review).
const autonomosConfigDir = () => getConfigDir();

const geminiSettingsPath = () =>
  join(autonomosConfigDir(), "gemini-settings.json");

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
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = geminiSettingsPath();

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
        // Token-delivery PRECONDITION for Gemini (ADR-055 follow-up) — NOT a
        // working-outbound fix. Gemini filters the env it passes to an MCP
        // subprocess down to a curated allowlist that EXCLUDES `*TOKEN*` names,
        // so we cannot hand the channel server AUTONOMOS_AGENT_TOKEN directly.
        // The server instead writes each agent's token to a 0600 file
        // (<configDir>/agent-tokens/<sessionId>); the channel server reads it,
        // deriving the path from CONFIG_DIR + SESSION_ID, both NON-secret names
        // the filter lets through. Do NOT add AUTONOMOS_AGENT_TOKEN back here —
        // Gemini strips it; the file is the delivery path. CONFIG_DIR is
        // agent-invariant so it is set explicitly in this SHARED (write-once)
        // settings file; SESSION_ID is per-process and reaches the channel server
        // via Gemini's env passthrough from the agent process (buildBaseEnv sets
        // it; non-`*TOKEN*`, so the allowlist passes it).
        //
        // AUTONOMOS_TOKEN (GLOBAL) authenticates the /ws/gateway UPGRADE itself:
        // `requireAuth` gates the socket before the gateway ever sees a `register`,
        // and the channel server presents it as the `?token=` query. Claude and
        // Codex both inject it into their channel-server env; Gemini must too, or
        // even a launched channel server would 401 before reaching register. It is
        // agent-invariant, so unlike SESSION_ID it can live in this shared file;
        // it is 0600, and getAuthToken() is populated (setAuthToken runs before
        // writeGeminiSettings at boot). The per-AGENT token is the separate 0600
        // FILE (read via CONFIG_DIR + SESSION_ID below), not this value.
        //
        // KNOWN OPEN GAP (verified by real-spawn QA, 2026-07-28): Gemini in this
        // `-i` PTY mode does NOT launch the autonomos MCP channel-server subprocess
        // AT ALL (ps shows the gemini process has no `dist.mjs` child), so it never
        // dials the gateway and outbound `send()`/org tools remain unavailable —
        // the SAME pre-existing gap as before this change, for a DEEPER reason than
        // credential delivery. This wiring makes BOTH tokens available once that
        // launch gap is fixed; it does not itself make Gemini outbound work. (Also
        // still unverified, part of the same follow-up: whether Gemini's `*TOKEN*`
        // env filter strips these EXPLICIT mcpServers.env values too, not just
        // inherited env — the ADR-055 finding was about inherited env.) Gemini HOOK
        // identity is unaffected and works (inbound/status). See agentCredentials.ts.
        env: {
          AUTONOMOS_SERVER_URL: `ws+unix://${socketPath}:/ws/gateway`,
          AUTONOMOS_API_URL: apiUrl,
          AUTONOMOS_CONFIG_DIR: autonomosConfigDir(),
          AUTONOMOS_TOKEN: getAuthToken(),
        },
      },
    },
  };

  // 0700 to match ensureConfigDir (configDir.ts): this creates the SAME config
  // root, and whichever site runs first on a fresh install sets the permanent
  // mode — so this one must agree, or an early Gemini spawn leaves the root 0755.
  mkdirSync(autonomosConfigDir(), { recursive: true, mode: 0o700 });
  writeFileSync(geminiSettingsPath(), JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });
  console.log(`[gemini-cli] wrote settings to ${geminiSettingsPath()}`);
}

export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}

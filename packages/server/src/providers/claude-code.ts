/**
 * Claude Code provider — translates generic SpawnOptions into
 * CC-specific CLI flags, env vars, and startup handling.
 */

import type {
  AgentProvider,
  PtyHandle,
  ResolvedSpawnOptions,
} from "@autonomos/core";
import { getSettings } from "../settings.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  HOOK_CMD,
  resolveBinaryFromCandidates,
} from "./shared.js";

// ── Hook relay ─────────────────────────────────────────────────
const HOOK_ENTRY = {
  matcher: "",
  hooks: [{ type: "command", command: HOOK_CMD, timeout: 3, async: true }],
} as const;

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "Notification",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

// ── Auto-trust: ANSI stripping + prompt needles ───────────────
const ANSI_RE =
  /\x1b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

const TRUST_NEEDLES = [
  "Yes,Itrustthisfolder",
  "Yes, I trust this folder",
  "Itrustthisfolder",
];
const CHANNELS_NEEDLES = [
  "WARNING: Loading development channels",
  "WARNING:Loadingdevelopmentchannels",
  "Iamusingthisforlocaldevelopment",
  "I am using this for local development",
];

// ── Binary resolution cache ───────────────────────────────────
const binaryCache = { path: null as string | null };

// ── Reserved env keys that buildEnv manages directly ──────────
const RESERVED_ENV_KEYS = new Set([
  "CLAUDECODE",
  "PORT",
  "PATH",
  "HOME",
  "AUTONOMOS_SERVER",
  "AUTONOMOS_SESSION_ID",
  "AUTONOMOS_AGENT_NAME",
]);

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",
  displayName: "Claude Code",

  capabilities: {
    hooks: { eventCount: 13, perSession: true, requiresSetup: false },
    mcp: { supported: true, perSession: true },
    systemPrompt: { supported: true, method: "flag" },
    messaging: { outbound: true, inbound: true, inboundMethod: "channels" },
    presetSessionId: true,
    sessionResume: true,
    sessionFork: true,
    agentNaming: true,
  },

  resolveBinary(): string {
    return resolveBinaryFromCandidates(
      "claude",
      commonBinaryCandidates("claude"),
      binaryCache,
    );
  },

  buildArgs(options: ResolvedSpawnOptions): string[] {
    const args: string[] = [];

    if (options.autonomousMode) {
      args.push("--dangerously-skip-permissions");
    }

    // Session identity: fork, resume, or new
    if (options.forkFrom) {
      args.push(
        "--resume",
        options.forkFrom,
        "--fork-session",
        "--session-id",
        options.providerSessionId,
      );
    } else if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    } else {
      args.push("--session-id", options.providerSessionId);
    }

    // Display name
    if (options.name) {
      args.push("--name", options.name);
    }

    // System prompt injection
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    } else {
      args.push(
        "--append-system-prompt",
        buildSystemPrompt(undefined, options.appendSystemPrompt),
      );
    }

    // SendUserMessage for structured agent-to-dashboard messaging
    args.push("--brief");

    // Inject configured channels
    const { channels } = getSettings();
    if (channels && channels.length > 0) {
      const devChannels = channels.filter((c) => c.startsWith("server:"));
      const officialChannels = channels.filter((c) => !c.startsWith("server:"));

      if (devChannels.length > 0) {
        args.push("--dangerously-load-development-channels", ...devChannels);
      }
      if (officialChannels.length > 0) {
        args.push("--channels", ...officialChannels);
      }

      // Inject MCP config for the autonomOS channel server
      if (options.injectChannelServer) {
        const mcpConfig = {
          mcpServers: {
            autonomos: {
              command: "node",
              args: [options.channelServerScript],
              env: {
                AUTONOMOS_SERVER_URL: `ws://localhost:${options.serverPort}/ws/gateway`,
                AUTONOMOS_SESSION_ID: options.sessionId,
                AUTONOMOS_AGENT_NAME: options.agentName,
                AUTONOMOS_CAPABILITIES: options.capabilities.join(","),
                ...(process.env.AUTONOMOS_TOKEN && {
                  AUTONOMOS_TOKEN: process.env.AUTONOMOS_TOKEN,
                }),
              },
            },
          },
        };
        args.push("--mcp-config", JSON.stringify(mcpConfig));
      }
    }

    // Hook relay — posts events to /api/hooks
    args.push(
      "--settings",
      JSON.stringify({
        hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [HOOK_ENTRY]])),
      }),
    );

    // User prompt (must be last, after --)
    if (options.prompt) {
      args.push("--", options.prompt);
    }

    return args;
  },

  buildEnv(sessionId: string, agentName: string): Record<string, string> {
    const env = buildBaseEnv(sessionId, agentName);
    delete env.CLAUDECODE;

    // Inject dashboard-configured settings as env vars
    const settings = getSettings();
    if (settings.anthropicOverrideEnabled !== false) {
      if (settings.anthropicBaseUrl) {
        env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
      }
      if (settings.anthropicAuthToken) {
        env.ANTHROPIC_AUTH_TOKEN = settings.anthropicAuthToken;
      }
    }

    // Inject user-defined custom env vars
    if (settings.customEnvVars) {
      for (const [key, value] of Object.entries(settings.customEnvVars)) {
        if (!RESERVED_ENV_KEYS.has(key)) {
          env[key] = value;
        }
      }
    }

    return env;
  },

  attachStartupWatcher(pty: PtyHandle, options: ResolvedSpawnOptions): void {
    // Expect the channels warning prompt if any dev channels are configured
    const { channels } = getSettings();
    const expectChannels =
      channels?.some((c) => c.startsWith("server:")) ?? false;

    let buf = "";
    const MAX_BUF = 8192;
    const answered = new Set<string>();
    let disposed = false;

    let ptyDead = false;

    function sendEnterBurst(promptId: string) {
      if (answered.has(promptId)) return;
      answered.add(promptId);
      const label = `${options.agentName} (${options.sessionId.slice(0, 8)})`;
      console.log(`[auto-trust] ${label} answered "${promptId}" prompt`);

      const delays = [50, 200, 500, 1000, 2000];
      for (const delay of delays) {
        setTimeout(() => {
          if (ptyDead) return;
          try {
            pty.write("\r");
          } catch (err) {
            ptyDead = true;
            console.warn(
              `[auto-trust] ${label} PTY write failed — process may have exited:`,
              err instanceof Error ? err.message : err,
            );
          }
        }, delay);
      }
    }

    const disposable = pty.onData((data: string) => {
      if (disposed) return;
      const clean = data.replace(ANSI_RE, "");
      buf += clean;
      if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);

      if (!answered.has("trust")) {
        for (const needle of TRUST_NEEDLES) {
          if (buf.includes(needle)) {
            sendEnterBurst("trust");
            break;
          }
        }
      }

      if (expectChannels && !answered.has("channels")) {
        for (const needle of CHANNELS_NEEDLES) {
          if (buf.includes(needle)) {
            if (!answered.has("trust")) answered.add("trust");
            sendEnterBurst("channels");
            break;
          }
        }
      }

      const needed = expectChannels ? 2 : 1;
      if (answered.size >= needed) cleanup();
    });

    const timer = setTimeout(() => {
      if (!disposed) {
        const unanswered: string[] = [];
        if (!answered.has("trust")) unanswered.push("trust");
        if (expectChannels && !answered.has("channels"))
          unanswered.push("channels");
        if (unanswered.length > 0) {
          console.warn(
            `[auto-trust] ${options.agentName} (${options.sessionId.slice(0, 8)}) timed out — never dismissed: ${unanswered.join(", ")}`,
          );
        }
        cleanup();
      }
    }, 30_000);

    function cleanup() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      disposable.dispose();
    }
  },
};

/** For testing — reset the cached binary path */
export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}

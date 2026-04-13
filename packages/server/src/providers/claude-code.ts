/**
 * Claude Code provider — translates generic SpawnOptions into
 * CC-specific CLI flags, env vars, and startup handling.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  AgentProvider,
  PtyHandle,
  ResolvedSpawnOptions,
} from "@autonomos/core";
import { MCP_INSTRUCTIONS } from "../mcp/tools.js";
import { getSettings } from "../settings.js";

// ── Hook relay ─────────────────────────────────────────────────
// Posts event JSON to /api/hooks via curl. No trailing & — Claude Code's
// async:true handles backgrounding (& would disconnect stdin, breaking -d @-).
const HOOK_CMD =
  'curl -sf --max-time 2 -X POST -H "Content-Type: application/json"' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell env var expansion
  ' -d @- "${AUTONOMOS_SERVER}/api/hooks/${AUTONOMOS_SESSION_ID}"' +
  " >/dev/null 2>&1";

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

// ── Base context injected into every spawned CC session ────────
const BASE_CONTEXT = `You are running inside autonomOS — an agent orchestration platform that manages \
AI coding agents for personal and enterprise use.

## Your Identity

You are a named agent in an organization. Other agents and the human operator \
can see you by name, send you messages, and observe your status. You may have \
a manager, peers, and direct reports — use get_org_chart() to see the hierarchy.

## Communication

${MCP_INSTRUCTIONS}

Messages are asynchronous — the recipient may be busy or idle. Do not block \
waiting for a response. Continue your work and handle replies when they arrive.

## Environment

- A human operator monitors all agents via a server dashboard, seeing status \
and notifications. You do not need to over-report — they can see your terminal.
- You may share a codebase with other agents. Some projects use the main branch \
(single agent), others use worktrees for isolation (multiple agents).
- You cannot access another agent's terminal or read their output directly. \
All inter-agent communication goes through send().

## Lifecycle

Some agents are long-lived (team leads, persistent roles). Others are spawned \
for a specific task — once the work is done and the PR is merged, they exit. \
Your session persists across server restarts until you, the human operator, or \
a managing agent (such as your manager or a superior) ends it.`;

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
let cachedBinaryPath: string | null = null;

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
    if (cachedBinaryPath) return cachedBinaryPath;

    const candidates = [
      `${process.env.HOME}/.local/bin/claude`,
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        cachedBinaryPath = p;
        return p;
      }
    }

    try {
      const which = execFileSync("which", ["claude"], {
        encoding: "utf-8",
      }).trim();
      if (which) {
        cachedBinaryPath = which;
        return which;
      }
    } catch {
      // not in PATH
    }

    throw new Error(
      `Claude binary not found. Searched: ${candidates.join(", ")} and PATH`,
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
      const parts: string[] = [BASE_CONTEXT];
      if (options.appendSystemPrompt) {
        parts.push("", "---", "", options.appendSystemPrompt);
      }
      args.push("--append-system-prompt", parts.join("\n"));
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
    const env = { ...process.env } as Record<string, string>;
    const extraPaths = [
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.bun/bin`,
      "/usr/local/bin",
    ];
    env.PATH = [...extraPaths, env.PATH].join(":");
    delete env.CLAUDECODE;
    delete env.PORT;

    const port = process.env.PORT || "3000";
    env.AUTONOMOS_SERVER = `http://localhost:${port}`;
    env.AUTONOMOS_SESSION_ID = sessionId;
    env.AUTONOMOS_AGENT_NAME = agentName;

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
    // (matches original behavior: checked for --dangerously-load-development-channels in args)
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
  cachedBinaryPath = null;
}

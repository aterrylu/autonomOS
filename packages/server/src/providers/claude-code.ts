/**
 * Claude Code provider — translates generic SpawnOptions into
 * CC-specific CLI flags, env vars, and startup handling.
 */

import type {
  AgentProvider,
  PtyHandle,
  ResolvedSpawnOptions,
} from "@autonomos/core";
import { STATUSLINE_SCRIPT } from "../scriptPaths.js";
import { getAuthToken } from "../serverState.js";
import { getInboxAgent, getSettings } from "../settings.js";
import {
  buildBaseEnv,
  buildSystemPrompt,
  commonBinaryCandidates,
  HOOK_CMD,
  resolveBinaryFromCandidates,
} from "./shared.js";

// ── Statusline renderer (runtime .mjs script, no build step) ──
const STATUSLINE_REFRESH_SECONDS = 5;

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

    // Inject configured channels (getSettings() deduplicates)
    const settings = getSettings();
    const { channels } = settings;
    if (channels && channels.length > 0) {
      // Plugin channels (plugin:*) go ONLY to the designated inbox agent —
      // the Telegram/Discord plugins each enforce a single-poller lock
      // (bot.pid with SIGTERM eviction), so fanning them out to every
      // session causes random-last-wins inbound routing. server:* channels
      // are safe to fan out and stay available to every agent.
      const isInbox = options.agentName === getInboxAgent(settings);
      const devChannels = channels.filter((c) => c.startsWith("server:"));
      const officialChannels = isInbox
        ? channels.filter((c) => !c.startsWith("server:"))
        : [];

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
                // Forward the in-process auth token (from serverState, set at
                // server boot in run.ts) rather than `process.env.AUTONOMOS_TOKEN`.
                // resolveAuthToken() falls back to ~/.autonomos/token on disk,
                // so when the server boots without the env var set, the token
                // lives only in module state — `process.env.AUTONOMOS_TOKEN`
                // would be undefined and the channel server would be rejected
                // by the gateway's /ws/* auth.
                AUTONOMOS_TOKEN: getAuthToken(),
              },
            },
          },
        };
        args.push("--mcp-config", JSON.stringify(mcpConfig));
      }
    }

    // Inline --settings payload:
    //   - hooks: relay every CC event to /api/hooks
    //   - statusLine (optional, default on): autonomOS-aware bar at the bottom
    //     of the CC terminal. Replaces the user's personal statusLine for
    //     spawned sessions only. CC merges these as parallel keys at the root.
    const settingsPayload: Record<string, unknown> = {
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [HOOK_ENTRY]])),
    };
    if (settings.statusLine?.enabled !== false) {
      // JSON.stringify produces a properly-escaped, double-quoted path —
      // safe against install paths containing spaces, quotes, $, backticks.
      settingsPayload.statusLine = {
        type: "command",
        command: `node ${JSON.stringify(STATUSLINE_SCRIPT)}`,
        refreshInterval: STATUSLINE_REFRESH_SECONDS,
      };
    }
    args.push("--settings", JSON.stringify(settingsPayload));

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
    attachStartupWatcherCore(pty, options, { expectChannels });
  },
};

export interface StartupWatcherConfig {
  expectChannels: boolean;
  /** How long to wait after an Enter before checking whether it landed. */
  retryDelayMs?: number;
  /** Max Enters per dialog before giving up. */
  maxAttempts?: number;
  /** Hard deadline for the whole watcher. */
  timeoutMs?: number;
}

/**
 * Auto-trust core — dismisses CC's startup dialogs (trust folder / dev
 * channels) with needle-driven retry.
 *
 * CC's TUI takes 100-500ms after first paint to attach its stdin handler, so
 * an Enter written too early is silently dropped — and a dialog that is never
 * dismissed blocks the argv-queued starting prompt forever. Instead of blind
 * staggered writes, each Enter is verified: if the SAME needle re-renders in
 * output produced after the write — or the PTY stays completely silent, which
 * means the write was swallowed pre-attach — send again, up to maxAttempts.
 * Fresh output without the needle is the dialog actually closing.
 *
 * Exported separately from the provider so tests can drive it with a fake PTY
 * and fast timings.
 */
export function attachStartupWatcherCore(
  pty: PtyHandle,
  options: ResolvedSpawnOptions,
  config: StartupWatcherConfig,
): void {
  const retryDelayMs = config.retryDelayMs ?? 500;
  const maxAttempts = config.maxAttempts ?? 5;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const label = `${options.agentName} (${options.sessionId.slice(0, 8)})`;

  const needles: Record<string, string[]> = {
    trust: TRUST_NEEDLES,
    channels: CHANNELS_NEEDLES,
  };
  const expected = config.expectChannels ? ["trust", "channels"] : ["trust"];

  interface DialogState {
    /** Needle seen — Enter sent, awaiting confirmation it landed. */
    engaged: boolean;
    /** No further action will be taken — confirmed gone, or gave up after
     *  maxAttempts. NOT a claim the dialog was actually dismissed. */
    settled: boolean;
    attempts: number;
    /** ANSI-stripped output received since the last Enter. */
    freshBuf: string;
    checkTimer: NodeJS.Timeout | null;
  }
  const dialogs = new Map<string, DialogState>(
    expected.map((id) => [
      id,
      {
        engaged: false,
        settled: false,
        attempts: 0,
        freshBuf: "",
        checkTimer: null,
      },
    ]),
  );

  let buf = "";
  const MAX_BUF = 8192;
  let disposed = false;
  let ptyDead = false;

  function writeEnter(): boolean {
    if (ptyDead) return false;
    try {
      pty.write("\r");
      return true;
    } catch (err) {
      ptyDead = true;
      console.warn(
        `[auto-trust] ${label} PTY write failed — process may have exited:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  function sendAndScheduleCheck(id: string, d: DialogState): void {
    d.attempts++;
    d.freshBuf = "";
    if (!writeEnter()) {
      cleanup();
      return;
    }
    d.checkTimer = setTimeout(() => {
      d.checkTimer = null;
      if (disposed) return;
      const stillVisible = needles[id].some((n) => d.freshBuf.includes(n));
      // Zero fresh output means the TUI never reacted — the Enter was most
      // likely swallowed before the stdin handler attached. Retry that too.
      const silent = d.freshBuf.length === 0;
      const notDismissed = stillVisible || silent;
      if (notDismissed && d.attempts < maxAttempts) {
        sendAndScheduleCheck(id, d);
        return;
      }
      if (notDismissed) {
        console.warn(
          `[auto-trust] ${label} "${id}" dialog not confirmed dismissed after ${d.attempts} attempts — giving up`,
        );
      } else if (d.attempts > 1) {
        console.log(
          `[auto-trust] ${label} "${id}" dismissed after ${d.attempts} attempts`,
        );
      }
      d.settled = true;
      maybeFinish();
    }, retryDelayMs);
  }

  function engage(id: string): void {
    const d = dialogs.get(id);
    if (!d || d.engaged || d.settled) return;
    d.engaged = true;
    console.log(`[auto-trust] ${label} answered "${id}" prompt`);
    sendAndScheduleCheck(id, d);
  }

  function maybeFinish(): void {
    for (const d of dialogs.values()) {
      if (!d.settled) return;
    }
    cleanup();
  }

  const disposable = pty.onData((data: string) => {
    if (disposed) return;
    const clean = data.replace(ANSI_RE, "");
    buf += clean;
    if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
    for (const d of dialogs.values()) {
      if (d.engaged && !d.settled) d.freshBuf += clean;
    }

    const trust = dialogs.get("trust");
    if (trust && !trust.engaged && TRUST_NEEDLES.some((n) => buf.includes(n))) {
      engage("trust");
    }

    const ch = dialogs.get("channels");
    if (ch && !ch.engaged && CHANNELS_NEEDLES.some((n) => buf.includes(n))) {
      // The channels dialog rendering implies the trust dialog is behind us.
      if (trust && !trust.engaged) {
        trust.settled = true;
        if (trust.checkTimer) clearTimeout(trust.checkTimer);
      }
      engage("channels");
    }
  });

  const timer = setTimeout(() => {
    if (disposed) return;
    const unanswered = expected.filter((id) => !dialogs.get(id)?.settled);
    const engaged = unanswered.filter((id) => dialogs.get(id)?.engaged);
    if (unanswered.length > 0) {
      console.warn(
        `[auto-trust] ${label} timed out — never dismissed: ${unanswered.join(", ")}` +
          (engaged.length > 0 ? ` (mid-retry: ${engaged.join(", ")})` : ""),
      );
    }
    cleanup();
  }, timeoutMs);

  function cleanup(): void {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    for (const d of dialogs.values()) {
      if (d.checkTimer) clearTimeout(d.checkTimer);
    }
    disposable.dispose();
  }
}

/** For testing — reset the cached binary path */
export function _resetBinaryCacheForTesting(): void {
  binaryCache.path = null;
}

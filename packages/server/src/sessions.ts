import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Session, SpawnOptions } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { DEFAULT_CAPABILITIES, MCP_INSTRUCTIONS } from "./mcp/tools.js";
import {
  getPersistedSessions,
  markSessionExited,
  persistSession,
  removePersistedSession,
} from "./persisted.js";
import { getSettings } from "./settings.js";
import { getTemplate } from "./templates.js";
import { batchGetTitles } from "./titleCache.js";

const OUTPUT_BUFFER_LIMIT = 1024 * 1024; // 1MB scrollback per session

// ── Hook relay config (injected per-session via --settings) ──────────
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

// ── Base context injected into every spawned session ─────────────
// The tool list section is imported from mcp/tools.ts (MCP_INSTRUCTIONS)
// to avoid maintaining the same list in two places.
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

export interface ManagedSession {
  session: Session;
  pty: IPty;
  outputBuffer: string[];
  outputSize: number;
}

const sessions = new Map<string, ManagedSession>();
let shuttingDown = false;

let claudePath: string | null = null;

/** Resolve claude binary at startup so we fail fast with a clear message. */
export function resolveClaudePath(): string {
  if (claudePath) return claudePath;

  // Try well-known paths first, then fall back to PATH lookup
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      claudePath = p;
      return p;
    }
  }

  try {
    const which = execFileSync("which", ["claude"], {
      encoding: "utf-8",
    }).trim();
    if (which) {
      claudePath = which;
      return which;
    }
  } catch {
    // not in PATH
  }

  throw new Error(
    `Claude binary not found. Searched: ${candidates.join(", ")} and PATH`,
  );
}

export function getSession(id: string): ManagedSession | undefined {
  return sessions.get(id);
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values()).map((s) => s.session);
}

export function expandPath(path: string): string {
  if (path.startsWith("~") && !process.env.HOME) {
    throw new Error("HOME environment variable is not set");
  }
  return path.replace(/^~/, process.env.HOME || "");
}

export function createSession(options: SpawnOptions): ManagedSession {
  // resumeSessionId is validated at the route boundary (routes/sessions.ts)

  // forkFrom and resumeSessionId are mutually exclusive
  if (options.forkFrom && options.resumeSessionId) {
    throw new Error(
      "Cannot use both forkFrom and resumeSessionId — fork creates a new session from the parent's context, resume reconnects to an existing session.",
    );
  }

  // Reject if a live agent with the same name is already running.
  // Exited agents in sessions.json may share names — only active ones must be unique.
  // INVARIANT: This check is safe because createSession() is fully synchronous —
  // no await points between here and sessions.set(). Adding an await would create
  // a TOCTOU race where two concurrent creates could both pass the check.
  if (options.name) {
    const needle = options.name.toLowerCase();
    const duplicate = getAllSessions().find(
      (s) => s.name.toLowerCase() === needle,
    );
    if (duplicate) {
      throw new Error(
        `An active agent named "${options.name}" is already running (id: ${duplicate.id}). ` +
          `Kill it first, or choose a different name.`,
      );
    }
  }

  const id = crypto.randomUUID();
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 40;
  const cwd = expandPath(options.workingDirectory);

  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Invalid working directory: ${cwd}`);
  }

  const binary = resolveClaudePath();

  // Compute defaultName early — needed for buildEnv (AUTONOMOS_AGENT_NAME)
  // and MCP config before args are fully constructed.
  const dirName = basename(cwd) || cwd;
  const shortId = id.slice(0, 4);
  const defaultName = options.name || `${dirName} · ${shortId}`;

  const env = buildEnv(id, defaultName);

  // Pre-generate Claude session ID — eliminates PTY regex parsing race condition.
  // For forks, always generate a new ID (the parent keeps its own).
  const claudeSessionId = options.forkFrom
    ? crypto.randomUUID()
    : options.resumeSessionId || crypto.randomUUID();

  const args: string[] = [];
  if (options.autonomousMode) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.forkFrom) {
    // Fork: load parent's conversation, create a new session with its own ID.
    // The parent session is untouched — child gets a copy of the context.
    args.push(
      "--resume",
      options.forkFrom,
      "--fork-session",
      "--session-id",
      claudeSessionId,
    );
  } else if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else {
    args.push("--session-id", claudeSessionId);
  }

  // Pass display name to Claude Code (shown in terminal title + /resume picker)
  if (options.name) {
    args.push("--name", options.name);
  }

  // System prompt injection
  if (options.systemPrompt) {
    // Full override — replaces CC defaults (rare)
    args.push("--system-prompt", options.systemPrompt);
  } else {
    // Build the appended system prompt: base autonomOS context + optional per-agent instructions
    const parts: string[] = [];

    // Base autonomOS context — tells the agent what environment it's in and what tools it has
    parts.push(BASE_CONTEXT);

    // Per-agent instructions from the orchestrator
    if (options.appendSystemPrompt) {
      parts.push("", "---", "", options.appendSystemPrompt);
    }

    args.push("--append-system-prompt", parts.join("\n"));
  }

  // Enable SendUserMessage tool for structured agent-to-dashboard messaging.
  // Agents route important replies through SendUserMessage with status labels
  // (normal/proactive). The hook relay intercepts these for notification badges.
  // Intentionally always on, including for --resume — the flag is ephemeral
  // (not stored in session) and must be re-passed on every spawn.
  args.push("--brief");

  // Inject configured channels (from settings.json)
  // Dev channels (server:*) use --dangerously-load-development-channels <entries>
  // Official plugins use --channels <entries>
  // They are separate flags — entries are arguments TO each flag
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

    // If server:autonomos is enabled, inject the MCP config so CC knows
    // how to spawn the channel server subprocess
    if (channels.includes("server:autonomos")) {
      // Use precompiled JS so CC can spawn with plain `node` — no tsx dependency
      const channelScript = resolve(
        import.meta.dirname,
        "channel-server/dist.mjs",
      );
      const port = process.env.PORT || "3000";

      // Resolve capabilities from template (or use defaults)
      const tmpl = options.template ? getTemplate(options.template) : null;
      const capabilities = tmpl?.capabilities ?? DEFAULT_CAPABILITIES;

      const mcpConfig = {
        mcpServers: {
          autonomos: {
            command: "node",
            args: [channelScript],
            env: {
              AUTONOMOS_SERVER_URL: `ws://localhost:${port}/ws/gateway`,
              AUTONOMOS_SESSION_ID: id,
              AUTONOMOS_AGENT_NAME: defaultName,
              AUTONOMOS_CAPABILITIES: capabilities.join(","),
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

  // Inject hook relay so Claude Code posts events to our /api/hooks endpoint
  args.push(
    "--settings",
    JSON.stringify({
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [HOOK_ENTRY]])),
    }),
  );

  if (options.prompt) {
    args.push("--", options.prompt);
  }

  // Log spawn command (truncate large JSON args for readability)
  const logArgs = args.map((a) => {
    if (a.startsWith('{"hooks"')) return '{"hooks":...}';
    if (a.startsWith('{"mcpServers"')) return '{"mcpServers":...}';
    return a;
  });
  console.log(`[session] spawning: ${binary} ${logArgs.join(" ")}`);

  const pty = spawn(binary, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  // Auto-answer startup trust/channel prompts so they don't block the session
  if (getSettings().autoTrust !== false) {
    const hasDevChannels = args.includes(
      "--dangerously-load-development-channels",
    );
    attachStartupWatcher(pty, hasDevChannels);
  }

  const session: Session = {
    id,
    name: defaultName,
    status: "running",
    workingDirectory: cwd,
    provider: "claude-code",
    claudeSessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const managed: ManagedSession = {
    session,
    pty,
    outputBuffer: [],
    outputSize: 0,
  };
  sessions.set(id, managed);

  // Persist immediately — claudeSessionId is always known at spawn time now
  persistSession({
    claudeSessionId,
    workingDirectory: cwd,
    name: defaultName,
    autonomousMode: !!options.autonomousMode,
    persistedAt: Date.now(),
    template: options.template,
    manager: options.manager,
    project: options.project,
  });

  pty.onData((data: string) => {
    managed.outputBuffer.push(data);
    managed.outputSize += data.length;

    // Trim buffer when it exceeds the limit — bulk splice to avoid O(n²) shift()
    if (managed.outputSize > OUTPUT_BUFFER_LIMIT) {
      let drop = 0;
      let freed = 0;
      while (
        drop < managed.outputBuffer.length - 1 &&
        managed.outputSize - freed > OUTPUT_BUFFER_LIMIT
      ) {
        freed += managed.outputBuffer[drop].length;
        drop++;
      }
      if (drop > 0) {
        managed.outputBuffer.splice(0, drop);
        managed.outputSize -= freed;
      }
    }
  });

  const spawnedAt = Date.now();

  pty.onExit(({ exitCode, signal }) => {
    const lifetime = Date.now() - spawnedAt;
    session.status = "stopped";
    session.updatedAt = Date.now();

    // Fast exit with non-zero code almost always means bad spawn args
    if (lifetime < 5_000 && exitCode !== 0) {
      console.error(
        `[session] ${id.slice(0, 8)} died immediately (${lifetime}ms), code=${exitCode}` +
          ` — likely a bad flag. Args: ${logArgs.join(" ")}`,
      );
    } else if (exitCode !== 0 || signal) {
      console.warn(
        `[session] ${id.slice(0, 8)} exited: code=${exitCode} signal=${signal ?? "none"} lifetime=${lifetime}ms`,
      );
    }

    if (!shuttingDown) {
      // Natural exit (Ctrl+C, agent finished, crash) — mark as exited in persistence
      if (session.claudeSessionId) {
        markSessionExited(session.claudeSessionId);
      }
      sessions.delete(id);
    }
    // When shuttingDown is true, keep in persistence so sessions auto-resume
    // on next server boot.
  });

  return managed;
}

export function killSession(id: string): boolean {
  const managed = sessions.get(id);
  if (!managed) return false;
  try {
    managed.pty.kill();
  } catch (err) {
    console.error(`Failed to kill PTY for session ${id}:`, err);
  }
  managed.session.status = "stopped";
  managed.session.updatedAt = Date.now();
  if (managed.session.claudeSessionId) {
    markSessionExited(managed.session.claudeSessionId);
  }
  sessions.delete(id);
  return true;
}

/**
 * Permanently remove a session — kill PTY if live, then delete from sessions.json.
 * Unlike killSession (which marks as exited), this truly deletes the record.
 */
export function permanentlyRemoveSession(id: string): boolean {
  // Kill PTY if this is a live session (killSession marks as exited, we'll overwrite below)
  const managed = sessions.get(id);
  if (managed) {
    killSession(id);
  }

  // Delete from persistence entirely (overrides the "exited" mark from killSession)
  const claudeId = managed?.session.claudeSessionId ?? id;
  const removed = removePersistedSession(claudeId);
  // If we killed a live PTY, that counts as success even if persistence removal
  // missed (killSession already marked it exited)
  return !!managed || removed;
}

/**
 * Kill all PTY processes without removing them from persistence.
 * Used during server shutdown so sessions survive reboots.
 */
export function shutdownAllSessions(): void {
  shuttingDown = true;
  for (const [, managed] of sessions) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort during shutdown
    }
  }
  sessions.clear();
}

/**
 * Kill all sessions AND remove from persistence.
 * Used when the user explicitly wants to clear everything.
 */
export function killAllSessions(): void {
  for (const [id] of sessions) {
    killSession(id);
  }
}

/**
 * Resolve a session by name or ID.
 * Steps: (1) exact UUID match, (2) raw s.name case-insensitive, (3) titleCache lookup.
 * Returns { id } on unique match, or { error } on ambiguity/not-found.
 */
export async function resolveSessionId(
  nameOrId: string,
): Promise<{ id: string } | { error: string }> {
  // 1. Exact UUID match
  if (sessions.has(nameOrId)) return { id: nameOrId };

  const allSessions = getAllSessions();
  const needle = nameOrId.toLowerCase();

  function uniqueMatch(
    matches: Session[],
  ): { id: string } | { error: string } | null {
    if (matches.length === 1) return { id: matches[0].id };
    if (matches.length > 1) {
      const list = matches.map((s) => `  ${s.name} (id: ${s.id})`).join("\n");
      return {
        error: `Multiple agents named "${nameOrId}". Specify by ID:\n${list}`,
      };
    }
    return null;
  }

  // 2. Raw s.name match (case-insensitive)
  const byName = uniqueMatch(
    allSessions.filter((s) => s.name.toLowerCase() === needle),
  );
  if (byName) return byName;

  // 3. titleCache lookup
  const withClaude = allSessions
    .filter((s) => s.claudeSessionId)
    .map((s) => ({
      sessionId: s.claudeSessionId!,
      cwd: s.workingDirectory,
    }));

  if (withClaude.length > 0) {
    const titles = await batchGetTitles(withClaude).catch((err) => {
      console.warn(
        "resolveSessionId: titleCache lookup failed:",
        err instanceof Error ? err.message : err,
      );
      return new Map<string, string>();
    });
    const byTitle = uniqueMatch(
      allSessions.filter((s) => {
        const title = s.claudeSessionId
          ? titles.get(s.claudeSessionId)
          : undefined;
        return (title ?? s.name).toLowerCase() === needle;
      }),
    );
    if (byTitle) return byTitle;
  }

  return { error: `Agent "${nameOrId}" not found.` };
}

/**
 * Restart all live sessions — kills each PTY and respawns with fresh env.
 * Preserves session IDs so the dashboard's layout/groups/panes remain valid.
 *
 * Strategy: snapshot all session info, kill all PTYs under shuttingDown flag
 * (prevents onExit from deleting sessions), clear the map, then respawn
 * each session via createSession with the same claudeSessionId.
 * The new session gets a new internal ID but the Claude session ID is preserved.
 *
 * Returns a mapping of old session IDs to new session IDs so the
 * dashboard can update its layout/groups/panes.
 */
export function restartAllSessions(): Record<string, string> {
  // Look up autonomousMode from persisted sessions
  const persisted = getPersistedSessions();
  const persistedMap = new Map(persisted.map((p) => [p.claudeSessionId, p]));

  // Snapshot sessions to restart (including old internal ID for remapping)
  const toRestart: Array<{
    oldId: string;
    claudeSessionId: string;
    workingDirectory: string;
    name: string;
    autonomousMode: boolean;
    template?: string;
    manager?: string;
    project?: string;
  }> = [];

  for (const [id, managed] of sessions) {
    const { session } = managed;
    if (session.claudeSessionId) {
      const p = persistedMap.get(session.claudeSessionId);
      toRestart.push({
        oldId: id,
        claudeSessionId: session.claudeSessionId,
        workingDirectory: session.workingDirectory,
        name: session.name,
        autonomousMode: p?.autonomousMode ?? false,
        template: p?.template,
        manager: p?.manager,
        project: p?.project,
      });
    }
  }

  // Kill all PTYs — use shuttingDown to prevent onExit cleanup
  shuttingDown = true;
  for (const [, managed] of sessions) {
    try {
      managed.pty.kill();
    } catch {
      // best-effort
    }
  }
  sessions.clear();
  shuttingDown = false;

  // Respawn each session, collecting old→new ID mapping
  const idMap: Record<string, string> = {};
  for (const info of toRestart) {
    try {
      // Re-resolve template system prompt so agents keep their role context
      const tmpl = info.template ? getTemplate(info.template) : null;
      if (info.template && !tmpl) {
        console.warn(
          `Template "${info.template}" not found for ${info.name} — agent will restart without role context`,
        );
      }

      const managed = createSession({
        workingDirectory: info.workingDirectory,
        name: info.name,
        resumeSessionId: info.claudeSessionId,
        autonomousMode: info.autonomousMode,
        appendSystemPrompt: tmpl?.systemPrompt,
        template: info.template,
        manager: info.manager,
        project: info.project,
      });
      idMap[info.oldId] = managed.session.id;
    } catch (err) {
      console.error(
        `Failed to restart session ${info.claudeSessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return idMap;
}

/** For testing — reset internal state */
export function _resetForTesting(): void {
  sessions.clear();
  claudePath = null;
}

/** For testing — inject a fake session into the in-memory Map (no PTY needed) */
export function _injectSessionForTesting(id: string, session: Session): void {
  sessions.set(id, {
    session,
    pty: null as unknown as IPty,
    outputBuffer: [],
    outputSize: 0,
  });
}

/** Keys that buildEnv manages directly — custom env vars cannot override these. */
const RESERVED_ENV_KEYS = new Set([
  "CLAUDECODE",
  "PORT",
  "PATH",
  "HOME",
  "AUTONOMOS_SERVER",
  "AUTONOMOS_SESSION_ID",
  "AUTONOMOS_AGENT_NAME",
]);

/**
 * Build environment with full PATH, strip CLAUDECODE to prevent
 * nested-session detection, and inject settings as env vars.
 * Not cached — settings can change between session spawns.
 */
function buildEnv(
  sessionId: string,
  agentName?: string,
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const extraPaths = [
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.bun/bin`,
    "/usr/local/bin",
  ];
  env.PATH = [...extraPaths, env.PATH].join(":");
  delete env.CLAUDECODE;
  delete env.PORT;

  // Identify this session to the hook relay script
  const port = process.env.PORT || "3000";
  env.AUTONOMOS_SERVER = `http://localhost:${port}`;
  env.AUTONOMOS_SESSION_ID = sessionId;
  if (agentName) {
    env.AUTONOMOS_AGENT_NAME = agentName;
  }

  // Inject dashboard-configured settings as env vars (only when override toggle is on)
  const settings = getSettings();
  if (settings.anthropicOverrideEnabled !== false) {
    if (settings.anthropicBaseUrl) {
      env.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;
    }
    if (settings.anthropicAuthToken) {
      env.ANTHROPIC_AUTH_TOKEN = settings.anthropicAuthToken;
    }
  }

  // Inject user-defined custom env vars — can override most things (e.g.
  // ANTHROPIC_BASE_URL) but not internal vars that buildEnv explicitly manages.
  if (settings.customEnvVars) {
    for (const [key, value] of Object.entries(settings.customEnvVars)) {
      if (!RESERVED_ENV_KEYS.has(key)) {
        env[key] = value;
      }
    }
  }

  return env;
}

// ── Auto-trust: dismiss Claude Code startup prompts ──────────────────

/** Strip ANSI escape sequences from PTY output for needle matching */
const ANSI_RE =
  /\x1b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

// Multiple needle variants per prompt for robustness — the TUI renders
// text via cursor positioning, so after ANSI stripping words may or may
// not have spaces between them depending on the terminal width.
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

/**
 * Watch PTY output during startup for interactive prompts that block
 * Claude Code from starting. Auto-answers by sending Enter (\r).
 *
 * Strategy: detect prompt needles in PTY output, then send Enter
 * multiple times with delays to handle timing variations. Sending
 * Enter when no prompt is showing is harmless — CC ignores it.
 *
 * Self-disposes after all expected prompts are handled or after 30s timeout.
 */
function attachStartupWatcher(pty: IPty, expectChannels: boolean): void {
  let buf = "";
  const MAX_BUF = 8192;
  const answered = new Set<string>();
  let disposed = false;

  /** Send Enter with multiple retries at increasing delays. */
  function sendEnterBurst(promptId: string) {
    if (answered.has(promptId)) return;
    answered.add(promptId);
    console.log(`[auto-trust] answered "${promptId}" prompt`);

    // Send Enter 5 times with increasing delays — at least one will land
    // when the TUI is ready. Extra Enters are harmless (CC ignores them).
    // NOTE: Don't check `disposed` — cleanup may fire before the burst
    // completes, but we still need the Enters to land.
    const delays = [50, 200, 500, 1000, 2000];
    for (const delay of delays) {
      setTimeout(() => {
        try {
          pty.write("\r");
        } catch {
          // PTY dead — ignore
        }
      }, delay);
    }
  }

  const disposable = pty.onData((data: string) => {
    if (disposed) return;
    const clean = data.replace(ANSI_RE, "");
    buf += clean;
    if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);

    // Check trust prompt
    if (!answered.has("trust")) {
      for (const needle of TRUST_NEEDLES) {
        if (buf.includes(needle)) {
          sendEnterBurst("trust");
          break;
        }
      }
    }

    // Check channels prompt (don't clear buf — trust and channels
    // may arrive in the same data chunk after trust is dismissed)
    if (expectChannels && !answered.has("channels")) {
      for (const needle of CHANNELS_NEEDLES) {
        if (buf.includes(needle)) {
          // If we see the channels prompt, trust was implicitly passed
          if (!answered.has("trust")) answered.add("trust");
          sendEnterBurst("channels");
          break;
        }
      }
    }

    const needed = expectChannels ? 2 : 1;
    if (answered.size >= needed) cleanup();
  });

  // 30s timeout
  const timer = setTimeout(() => {
    if (!disposed) {
      const unanswered: string[] = [];
      if (!answered.has("trust")) unanswered.push("trust");
      if (expectChannels && !answered.has("channels"))
        unanswered.push("channels");
      if (unanswered.length > 0) {
        console.warn(
          `[auto-trust] timed out — never dismissed: ${unanswered.join(", ")}`,
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
}

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Session, SpawnOptions } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import {
  getPersistedSessions,
  persistSession,
  removePersistedSession,
} from "./persisted.js";
import { getSettings } from "./settings.js";

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

  const env = buildEnv(id);

  // Pre-generate Claude session ID — eliminates PTY regex parsing race condition
  const claudeSessionId = options.resumeSessionId || crypto.randomUUID();

  const args: string[] = [];
  if (options.autonomousMode) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else {
    args.push("--session-id", claudeSessionId);
  }

  // Pass display name to Claude Code (shown in terminal title + /resume picker)
  if (options.name) {
    args.push("--name", options.name);
  }

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
      const mcpConfig = {
        mcpServers: {
          autonomos: {
            command: "node",
            args: [channelScript],
            env: {
              AUTONOMOS_SERVER_URL: `ws://localhost:${port}/ws/gateway`,
              AUTONOMOS_SESSION_ID: id,
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

  const dirName = basename(cwd) || cwd;
  const shortId = id.slice(0, 4);
  const defaultName = options.name || `${dirName} · ${shortId}`;

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

  pty.onExit(() => {
    session.status = "stopped";
    session.updatedAt = Date.now();
    if (!shuttingDown) {
      // Natural exit (Ctrl+C, agent finished, crash) — remove from persistence
      if (session.claudeSessionId) {
        removePersistedSession(session.claudeSessionId);
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
    removePersistedSession(managed.session.claudeSessionId);
  }
  sessions.delete(id);
  return true;
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
      const managed = createSession({
        workingDirectory: info.workingDirectory,
        name: info.name,
        resumeSessionId: info.claudeSessionId,
        autonomousMode: info.autonomousMode,
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

/**
 * Build environment with full PATH, strip CLAUDECODE to prevent
 * nested-session detection, and inject settings as env vars.
 * Not cached — settings can change between session spawns.
 */
function buildEnv(sessionId: string): Record<string, string> {
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

  return env;
}

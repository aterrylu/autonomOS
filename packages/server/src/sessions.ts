import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Session, SpawnOptions } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { persistSession, removePersistedSession } from "./persisted.js";

const OUTPUT_BUFFER_LIMIT = 1024 * 1024; // 1MB scrollback per session

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

  const env = buildEnv();

  const args: string[] = [];
  if (options.autonomousMode) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  if (options.prompt) {
    args.push("--", options.prompt);
  }

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
    claudeSessionId: options.resumeSessionId,
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

  // Auto-persist sessions that have a Claude session ID
  if (session.claudeSessionId) {
    persistSession({
      claudeSessionId: session.claudeSessionId,
      workingDirectory: cwd,
      name: defaultName,
      autonomousMode: !!options.autonomousMode,
      persistedAt: Date.now(),
    });
  }

  pty.onData((data: string) => {
    managed.outputBuffer.push(data);
    managed.outputSize += data.length;

    // Detect Claude session ID from PTY output for fresh (non-resumed) sessions.
    // Claude Code prints "Session: <uuid>" near the start of output.
    if (!session.claudeSessionId) {
      const match = data.match(
        /Session:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      );
      if (match) {
        session.claudeSessionId = match[1];
        persistSession({
          claudeSessionId: match[1],
          workingDirectory: cwd,
          name: defaultName,
          autonomousMode: !!options.autonomousMode,
          persistedAt: Date.now(),
        });
      }
    }

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
      if (session.claudeSessionId) {
        removePersistedSession(session.claudeSessionId);
      }
      sessions.delete(id);
    }
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

/** For testing — reset internal state */
export function _resetForTesting(): void {
  sessions.clear();
  claudePath = null;
}

/**
 * Build environment with full PATH and strip CLAUDECODE
 * to prevent nested-session detection. Computed once since
 * process.env doesn't change at runtime.
 */
let cachedEnv: Record<string, string> | null = null;

function buildEnv(): Record<string, string> {
  if (cachedEnv) return cachedEnv;
  const env = { ...process.env } as Record<string, string>;
  const extraPaths = [
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.bun/bin`,
    "/usr/local/bin",
  ];
  env.PATH = [...extraPaths, env.PATH].join(":");
  delete env.CLAUDECODE;
  delete env.PORT;
  cachedEnv = env;
  return env;
}

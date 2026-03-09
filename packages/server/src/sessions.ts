import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Session, SpawnOptions } from "@autonomos/core";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";

const OUTPUT_BUFFER_LIMIT = 100 * 1024; // 100KB scrollback per session

export interface ManagedSession {
  session: Session;
  pty: IPty;
  outputBuffer: string[];
  outputSize: number;
}

const sessions = new Map<string, ManagedSession>();

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
  if (
    options.resumeSessionId &&
    !/^[a-zA-Z0-9_-]+$/.test(options.resumeSessionId)
  ) {
    throw new Error("Invalid resumeSessionId format");
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

  const env = buildEnv();

  const args: string[] = ["--dangerously-skip-permissions"];
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

  const basename = cwd.split("/").pop() || cwd;
  const shortId = id.slice(0, 4);
  const defaultName = options.name || `${basename} · ${shortId}`;

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

  pty.onData((data: string) => {
    managed.outputBuffer.push(data);
    managed.outputSize += data.length;
    // Trim buffer when it exceeds the limit
    while (
      managed.outputSize > OUTPUT_BUFFER_LIMIT &&
      managed.outputBuffer.length > 1
    ) {
      managed.outputSize -= managed.outputBuffer.shift()!.length;
    }
  });

  pty.onExit(() => {
    session.status = "stopped";
    session.updatedAt = Date.now();
    sessions.delete(id);
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
  sessions.delete(id);
  return true;
}

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
 * to prevent nested-session detection.
 */
function buildEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const extraPaths = [
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.bun/bin`,
    "/usr/local/bin",
  ];
  env.PATH = [...extraPaths, env.PATH].join(":");
  delete env.CLAUDECODE;
  return env;
}

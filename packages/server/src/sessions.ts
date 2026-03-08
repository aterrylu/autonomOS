import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  const id = crypto.randomUUID();
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 40;
  const cwd = expandPath(options.workingDirectory);
  const binary = resolveClaudePath();

  const env = buildEnv();

  // Prevent prompt from being interpreted as CLI flags
  const args = options.prompt ? ["--", options.prompt] : [];

  const pty = spawn(binary, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  });

  const session: Session = {
    id,
    name: `Session ${sessions.size + 1}`,
    status: "running",
    workingDirectory: cwd,
    provider: "claude-code",
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

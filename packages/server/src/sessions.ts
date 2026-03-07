import type { Session, SpawnOptions } from "@autonomos/core";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { existsSync } from "node:fs";

export interface ManagedSession {
  session: Session;
  pty: IPty;
}

const sessions = new Map<string, ManagedSession>();

export function getSession(id: string): ManagedSession | undefined {
  return sessions.get(id);
}

export function getAllSessions(): Session[] {
  return Array.from(sessions.values()).map((s) => s.session);
}

function resolveClaudePath(): string {
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Claude binary not found. Searched: ${candidates.join(", ")}`
  );
}

export function createSession(options: SpawnOptions): ManagedSession {
  const id = crypto.randomUUID();
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 40;
  const cwd = options.workingDirectory.replace(
    /^~/,
    process.env.HOME || "/tmp"
  );

  const env = buildEnv();
  const claudePath = resolveClaudePath();

  // Prevent prompt from being interpreted as CLI flags
  const args = options.prompt ? ["--", options.prompt] : [];

  const pty = spawn(claudePath, args, {
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
    workingDirectory: options.workingDirectory,
    provider: "claude-code",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const managed: ManagedSession = { session, pty };
  sessions.set(id, managed);

  pty.onExit(() => {
    session.status = "stopped";
    session.updatedAt = Date.now();
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

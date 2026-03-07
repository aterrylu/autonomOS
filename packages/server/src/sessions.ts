import type { Session, SessionStatus } from "@autonomos/core";
import { spawn } from "node-pty";
import type { IPty } from "node-pty";

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

export function createSession(options: {
  workingDirectory: string;
  prompt?: string;
  cols?: number;
  rows?: number;
}): ManagedSession {
  const id = crypto.randomUUID();
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 40;
  const cwd = options.workingDirectory.replace(/^~/, process.env.HOME || "/tmp");

  // Build env with full PATH — Bun's process.env may not include
  // shell profile paths like ~/.local/bin where claude lives
  const env = { ...process.env } as Record<string, string>;
  const extraPaths = [
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.bun/bin`,
    "/usr/local/bin",
  ];
  env.PATH = [...extraPaths, env.PATH].join(":");

  // Remove CLAUDECODE env var — prevents "nested session" detection
  // when autonomOS server itself runs inside a Claude Code session
  delete env.CLAUDECODE;

  // Resolve claude binary — node-pty needs the full path when running under Bun
  const claudePath = `${process.env.HOME}/.local/bin/claude`;

  // Spawn Claude Code as a PTY subprocess
  const pty = spawn(claudePath, options.prompt ? [options.prompt] : [], {
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

  pty.onExit(({ exitCode }) => {
    session.status = "stopped";
    session.updatedAt = Date.now();
  });

  return managed;
}

export function killSession(id: string): boolean {
  const managed = sessions.get(id);
  if (!managed) return false;
  managed.pty.kill();
  managed.session.status = "stopped";
  managed.session.updatedAt = Date.now();
  return true;
}

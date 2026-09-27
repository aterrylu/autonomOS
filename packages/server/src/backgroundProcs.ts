// Background processes an update restart would stop (ADR-105 follow-up).
//
// "Busy" is read from each agent's status, so an agent that pushed a command
// into a background shell and ended its turn reads Idle — and an update
// restart kills that shell with it. Claude Code in auto mode does this on its
// own for long commands. This finds that work so the pre-flight can WARN (it
// never blocks: the operator decides).
//
// What counts: SHELLS that are DIRECT children of an agent's process roots —
// the CLI in its PTY and, for Codex, the app-server daemon that runs its
// commands. Measured on forge (CC 2.1.28x): a backgrounded Bash-tool command
// is `/bin/bash -c source …shell-snapshot… eval '…'` directly under `claude`,
// with the real command below it; MCP servers hang off their own launchers
// (`npm exec @playwright/mcp` → `sh -c playwright-mcp`), so their shells are
// grandchildren and must NOT count. Shells younger than MIN_AGE_S are
// ignored: hook relays and statusline runs are direct-child shells too, but
// they live for milliseconds.

import { spawnSync } from "node:child_process";

export type ProcRow = {
  pid: number;
  ppid: number;
  /** Seconds since start. */
  ageS: number;
  args: string;
};

export type BackgroundProc = { pid: number; command: string };

export const MIN_AGE_S = 3;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);

function exeName(args: string): string {
  const first = args.trim().split(/\s+/, 1)[0] ?? "";
  return (first.split("/").pop() ?? "").replace(/^-/, "");
}

/** `ps` elapsed time: [[dd-]hh:]mm:ss → seconds. */
export function parseEtime(etime: string): number {
  const [days, rest] = etime.includes("-")
    ? (etime.split("-", 2) as [string, string])
    : ["0", etime];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  const total = Number(days) * 86_400 + h * 3600 + m * 60 + s;
  return Number.isFinite(total) ? total : 0;
}

/** One `ps` for the whole table (same flags on Linux and macOS). */
export function listProcesses(): ProcRow[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,etime=,args="], {
    encoding: "utf-8",
    timeout: 3_000,
  });
  if (r.status !== 0 || !r.stdout) return [];
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      ageS: parseEtime(m[3]),
      args: m[4],
    });
  }
  return rows;
}

/** A short, human label for a shell subtree: its first non-shell
 *  descendant's command line (CC's `-c` string is a long shell-snapshot
 *  prelude), else the shell's own `-c` command. */
function describe(shell: ProcRow, children: Map<number, ProcRow[]>): string {
  const queue = [...(children.get(shell.pid) ?? [])];
  while (queue.length) {
    const p = queue.shift() as ProcRow;
    if (!SHELLS.has(exeName(p.args))) return p.args;
    queue.push(...(children.get(p.pid) ?? []));
  }
  const c = /\s-l?c\s+(.+)$/.exec(shell.args);
  return c ? c[1] : shell.args;
}

/**
 * The background shell subtrees directly under `roots`. Pure: the process
 * table is passed in.
 */
export function findBackgroundProcs(
  table: readonly ProcRow[],
  roots: readonly number[],
): BackgroundProc[] {
  const children = new Map<number, ProcRow[]>();
  for (const p of table) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: BackgroundProc[] = [];
  for (const root of roots) {
    for (const child of children.get(root) ?? []) {
      if (!SHELLS.has(exeName(child.args)) || child.ageS < MIN_AGE_S) continue;
      out.push({
        pid: child.pid,
        command: describe(child, children).slice(0, 200),
      });
    }
  }
  return out;
}

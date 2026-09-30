/**
 * On-disk records of each agent's sidecar daemon, and the reaper that stops a
 * daemon a previous server left behind (ADR: reap orphaned Codex daemons).
 *
 * Why: a daemon's pid used to live only in this process's memory. When the
 * server dies without disposing it (SIGKILL, crash, power), Codex's
 * `app-server` keeps running, reparented to init, and keeps the agent's
 * conversation thread LOADED. A new daemon can't load a thread another daemon
 * holds, so the resumed agent's `thread/loaded/list` stays empty: inbound never
 * lands and its channel server never starts (measured on codex 0.157.1, on
 * both a boot resume and a graceful /restart while the orphan lived).
 *
 * So every started daemon is recorded as `$configDir/sidecars/<agentId>.json`
 * ({pid, endpoint, startedAt}, 0600) and forgotten when it has really exited.
 * Before any new daemon for an agent starts, a recorded one that is still
 * alive is stopped the Codex way (TERM, TERM, then KILL). A pid is only
 * signaled when its command line still carries `app-server --listen
 * <recorded endpoint>`: a recycled pid belonging to anything else is never
 * touched. The endpoint is matched VERBATIM from the record, never re-derived,
 * because it changes on every spawn.
 */

import { execFile } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../configDir.js";
import {
  runningSidecarPids,
  SIDECAR_FORCE_TERM_MS,
  SIDECAR_KILL_AFTER_MS,
} from "./sidecar.js";

export interface SidecarRecord {
  pid: number;
  endpoint: string;
  startedAt: number;
}

/** What reapOrphanSidecar did, for the log and tests. */
export type ReapOutcome =
  | "none" // no record
  | "gone" // recorded daemon already exited
  | "ours" // it's a daemon this process runs: left alone
  | "not-daemon" // the pid now belongs to something else: left alone
  | "reaped" // stopped
  | "survived"; // still alive after TERM, TERM and KILL

/** How long a reap waits for the orphan to disappear after SIGKILL. */
export const REAP_EXIT_CAP_MS = 3_000;

function dir(): string {
  return join(getConfigDir(), "sidecars");
}

function file(agentId: string): string {
  return join(dir(), `${agentId}.json`);
}

export function readSidecarRecord(agentId: string): SidecarRecord | null {
  try {
    const r = JSON.parse(readFileSync(file(agentId), "utf8"));
    if (
      r &&
      Number.isInteger(r.pid) &&
      r.pid > 0 &&
      typeof r.endpoint === "string" &&
      r.endpoint.length > 0
    )
      return {
        pid: r.pid,
        endpoint: r.endpoint,
        startedAt: Number(r.startedAt) || 0,
      };
  } catch {
    // missing or unreadable: treated as no record below
  }
  return null;
}

/** Record a started daemon. Atomic, 0600, in a 0700 directory. */
export function recordSidecar(agentId: string, rec: SidecarRecord): void {
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    const tmp = `${file(agentId)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    renameSync(tmp, file(agentId));
  } catch (err) {
    // Not fatal to the spawn, but the daemon won't be reaped after a crash.
    console.warn(
      `[sidecar] couldn't record daemon pid ${rec.pid} for ${agentId}: ${(err as Error).message}`,
    );
  }
}

/** Forget a daemon once it has exited — only if the record is still ITS
 *  (a newer daemon may already have replaced it). */
export function forgetSidecar(agentId: string, pid: number): void {
  if (readSidecarRecord(agentId)?.pid !== pid) return;
  rmSync(file(agentId), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but isn't ours to signal — alive, and not reapable.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The process's full command line, or null if it can't be read. */
function commandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      { timeout: 5_000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** Whether `cmd` is a sidecar daemon listening on exactly `endpoint`. */
export function isDaemonFor(cmd: string, endpoint: string): boolean {
  const args = cmd.split(/\s+/);
  const i = args.indexOf("--listen");
  return args.includes("app-server") && i >= 0 && args[i + 1] === endpoint;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid: number, capMs: number): Promise<boolean> {
  const until = Date.now() + capMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return !isAlive(pid);
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

/**
 * Stop the daemon a previous server left for `agentId`, if there is one.
 * Always leaves no record behind unless the daemon survived every signal.
 */
export async function reapOrphanSidecar(agentId: string): Promise<ReapOutcome> {
  const rec = readSidecarRecord(agentId);
  if (!rec) {
    rmSync(file(agentId), { force: true }); // an unreadable record is useless
    return "none";
  }
  // A daemon this process started is tracked and disposed by its own
  // lifecycle; never signal it from here.
  if (runningSidecarPids().includes(rec.pid)) return "ours";
  if (!isAlive(rec.pid)) {
    rmSync(file(agentId), { force: true });
    return "gone";
  }
  const cmd = await commandLine(rec.pid);
  if (!cmd || !isDaemonFor(cmd, rec.endpoint)) {
    // The pid was recycled (or can't be read): not ours to signal.
    rmSync(file(agentId), { force: true });
    console.warn(
      `[sidecar] ${agentId}: recorded daemon pid ${rec.pid} is no longer its daemon (${cmd ?? "command line unreadable"}); left alone`,
    );
    return "not-daemon";
  }
  console.warn(
    `[sidecar] ${agentId}: stopping an orphaned daemon from a previous server (pid ${rec.pid}, ${rec.endpoint}): it would keep the agent's thread loaded`,
  );
  // Codex's two-stage stop (see SIDECAR_FORCE_TERM_MS): the first TERM drains,
  // the second aborts and reaps its children; KILL is the backstop.
  signal(rec.pid, "SIGTERM");
  if (!(await waitGone(rec.pid, SIDECAR_FORCE_TERM_MS))) {
    signal(rec.pid, "SIGTERM");
    if (
      !(await waitGone(rec.pid, SIDECAR_KILL_AFTER_MS - SIDECAR_FORCE_TERM_MS))
    ) {
      signal(rec.pid, "SIGKILL");
      if (!(await waitGone(rec.pid, REAP_EXIT_CAP_MS))) {
        console.error(
          `[sidecar] ${agentId}: orphaned daemon pid ${rec.pid} survived SIGKILL; the new daemon may not be able to load the agent's thread`,
        );
        return "survived";
      }
    }
  }
  rmSync(file(agentId), { force: true });
  return "reaped";
}

/** Boot: reap every recorded orphan, including agents that won't resume. */
export async function reapAllOrphanSidecars(): Promise<
  Array<{ agentId: string; outcome: ReapOutcome }>
> {
  let names: string[];
  try {
    names = readdirSync(dir());
  } catch {
    return []; // no records yet
  }
  const ids = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length));
  return Promise.all(
    ids.map(async (agentId) => ({
      agentId,
      outcome: await reapOrphanSidecar(agentId),
    })),
  );
}

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
  | "survived" // still alive after TERM, TERM and KILL
  | "unverified"; // alive but couldn't be identified (or the check failed): left alone, record kept

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
 *  (a newer daemon may already have replaced it). Never throws: it runs in the
 *  daemon's exit listener, where a throw would take the server down. */
export function forgetSidecar(agentId: string, pid: number): void {
  try {
    if (readSidecarRecord(agentId)?.pid !== pid) return;
    rmSync(file(agentId), { force: true });
  } catch (err) {
    console.warn(
      `[sidecar] couldn't remove the record of daemon pid ${pid} for ${agentId}: ${(err as Error).message}`,
    );
  }
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

/**
 * The process's command line: its exact argv where the OS exposes it (Linux
 * /proc), else `ps`'s joined string. Null when it can't be read.
 */
function commandLine(pid: number): Promise<string[] | string | null> {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter(Boolean);
    if (argv.length > 0) return Promise.resolve(argv);
  } catch {
    // not Linux (or gone): fall back to ps
  }
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-ww", "-o", "command=", "-p", String(pid)],
      { timeout: 5_000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a command line is a sidecar daemon listening on exactly `endpoint`.
 * With an argv (Linux) the match is exact; with `ps`'s joined string the whole
 * endpoint must follow `--listen ` and end at whitespace or the end, so an
 * endpoint containing spaces (a config dir under "Application Support") still
 * matches and a prefix of another endpoint doesn't.
 */
export function isDaemonFor(cmd: string[] | string, endpoint: string): boolean {
  if (Array.isArray(cmd)) {
    const i = cmd.indexOf("--listen");
    return cmd.includes("app-server") && i >= 0 && cmd[i + 1] === endpoint;
  }
  return (
    /(^|\s)app-server(\s|$)/.test(cmd) &&
    new RegExp(`(^|\\s)--listen ${escapeRe(endpoint)}(\\s|$)`).test(cmd)
  );
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
 * Never throws (it runs on the spawn path and at boot). Every removal after an
 * await is compare-and-delete (forgetSidecar), so a concurrent reap that has
 * already started a NEWER daemon never loses that daemon's record.
 */
export async function reapOrphanSidecar(agentId: string): Promise<ReapOutcome> {
  try {
    return await reap(agentId);
  } catch (err) {
    console.warn(
      `[sidecar] ${agentId}: couldn't check for an orphaned daemon: ${(err as Error).message}`,
    );
    return "unverified";
  }
}

async function reap(agentId: string): Promise<ReapOutcome> {
  const rec = readSidecarRecord(agentId);
  if (!rec) {
    rmSync(file(agentId), { force: true }); // an unreadable record is useless
    return "none";
  }
  // A daemon this process started (even one still starting) is tracked and
  // disposed by its own lifecycle; never signal it from here.
  if (runningSidecarPids().includes(rec.pid)) return "ours";
  if (!isAlive(rec.pid)) {
    forgetSidecar(agentId, rec.pid);
    return "gone";
  }
  const cmd = await commandLine(rec.pid);
  if (cmd === null) {
    if (!isAlive(rec.pid)) {
      forgetSidecar(agentId, rec.pid); // it exited while we looked
      return "gone";
    }
    // Alive but unidentifiable: never signal it, and KEEP the record so a
    // later spawn or boot can try again — the caller tells the operator.
    console.warn(
      `[sidecar] ${agentId}: recorded daemon pid ${rec.pid} is alive but its command line couldn't be read; not stopped`,
    );
    return "unverified";
  }
  if (!isDaemonFor(cmd, rec.endpoint)) {
    // The pid was recycled: not ours to signal, and the record is stale.
    forgetSidecar(agentId, rec.pid);
    console.warn(
      `[sidecar] ${agentId}: recorded daemon pid ${rec.pid} is no longer its daemon; left alone`,
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
  forgetSidecar(agentId, rec.pid);
  return "reaped";
}

/** Boot: reap every recorded orphan, including agents that won't resume. One
 *  agent's failure never cuts the others' reaps short (all settle first). */
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
  const settled = await Promise.allSettled(ids.map(reapOrphanSidecar));
  return ids.map((agentId, i) => {
    const r = settled[i];
    return {
      agentId,
      outcome: r.status === "fulfilled" ? r.value : "unverified",
    };
  });
}

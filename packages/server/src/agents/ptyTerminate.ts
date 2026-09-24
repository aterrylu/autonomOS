/**
 * Terminate an agent's PTY process GROUP, with a bounded escalation.
 *
 * node-pty's `pty.kill()` is `process.kill(pid, "SIGHUP")` on the leader pid
 * ONLY, with errors swallowed. Measured 2026-09-24 against the real CLIs, each
 * in a fresh PTY: claude and the codex TUI die to it, but gemini does NOT — its
 * wrapper ignores SIGHUP and the relaunched child never sees the signal, so
 * both survive (restart-all leaked one gemini per restart; shutdown left it
 * lingering). A signal to the GROUP (`-pid`: the PTY child is a session leader,
 * so its pgid is its pid) reaches the relaunched child, which exits, and the
 * wrapper follows. Closing the PTY master (`destroy()`) alone did not help.
 *
 * Escalation: SIGHUP to the group now, SIGTERM at `termAfterMs`, SIGKILL at
 * `killAfterMs` — for as long as the LEADER is alive (see PID-reuse below).
 * Every process in the group gets the SIGHUP; one that survives it AND outlives
 * the leader gets no further signal, and is reported by name instead (the
 * straggler log). Measured: none of claude / codex / gemini leaves one. It does
 * NOT reach work the agent put in a group of its own: Claude Code's Bash tool
 * runs each command in a separate process group, so `nohup … &` from an agent
 * is out of reach here (and, reparented to init, of any kill).
 *
 * PID-reuse safety: every pending stage is cancelled when the PTY's onExit
 * fires, and an ESRCH ends the escalation (the group is gone) with no fallback
 * to the bare pid. node-pty reaps the leader up to ~200ms BEFORE it emits exit
 * (it waits for the master socket to close), so a fallback signal to the pid
 * in that window could reach a reused one.
 *
 * Precondition: `pty` has not exited yet. onExit does not replay a past exit,
 * so an already-exited PTY would never settle. The runtime only passes PTYs
 * still in its `live` map, which the canonical onExit removes.
 */

import { execFile, execFileSync } from "node:child_process";
import type { IPty } from "node-pty";

export const PTY_TERM_AFTER_MS = 250;
export const PTY_KILL_AFTER_MS = 2_000;

export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

export interface TerminatePtyOptions {
  termAfterMs?: number;
  killAfterMs?: number;
  /** Injected for tests; defaults to process.kill. */
  signal?: SignalFn;
  /** Names the agent in log lines. */
  label?: string;
}

const PS_TIMEOUT_MS = 1_000;
const PGID_TABLE_TTL_MS = 500;

/**
 * pgid of every process, from one `ps` — reused for a short window so a burst
 * of kills (shutdown, restart-all: one per agent) costs a single `ps`. A failed
 * read is cached too (as null), so a broken `ps` isn't retried per agent.
 */
let pgidTable: { at: number; pgids: number[] | null } | undefined;

function parsePgids(out: string): number[] {
  return out.split("\n").map((l) => Number(l.trim()));
}

/** Processes in the group at kill time, or undefined if it can't be read. */
function groupSize(pgid: number): number | undefined {
  const now = Date.now();
  if (!pgidTable || now - pgidTable.at > PGID_TABLE_TTL_MS) {
    let pgids: number[] | null = null;
    try {
      pgids = parsePgids(
        execFileSync("ps", ["-axo", "pgid="], {
          encoding: "utf8",
          timeout: PS_TIMEOUT_MS,
        }),
      );
    } catch (err) {
      console.debug(
        `[pty] ps for group sizes failed: ${(err as Error).message}`,
      );
    }
    pgidTable = { at: now, pgids };
  }
  return pgidTable.pgids?.filter((g) => g === pgid).length;
}

/**
 * After the leader exits: report any group member that outlived it — agent
 * label, count, and command NAMES only (never args, which can carry secrets).
 * Async and fresh (never the cached table, which predates the kill), so it
 * neither blocks nor mis-counts. Observability only: nothing is signalled, per
 * the PID-reuse rule above. If this ever fires in practice, that's the evidence
 * for continuing the escalation past the leader's exit.
 */
function reportStragglers(pgid: number, label: string): void {
  execFile(
    "ps",
    ["-axo", "pgid=,comm="],
    { encoding: "utf8", timeout: PS_TIMEOUT_MS },
    (err, out) => {
      if (err) return;
      const names = out
        .split("\n")
        .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m && Number(m[1]) === pgid)
        .map((m) => m[2].split("/").pop() ?? m[2]);
      if (names.length > 0) {
        console.warn(
          `[pty] ${label} exited but ${names.length} process(es) in its group outlived it (${names.join(", ")}) — they got SIGHUP only and may still be running`,
        );
      }
    },
  );
}

type TerminablePty = Pick<IPty, "pid" | "onExit" | "kill">;

/** One escalation per PTY: a kill followed by shutdown reuses the first. */
const inFlight = new WeakMap<TerminablePty, Promise<void>>();
/** Every PTY between terminatePty() and its exit, with its label. */
const exiting = new Map<Promise<void>, string>();

/**
 * Begin terminating `pty`'s process group. Resolves when the PTY has exited.
 * Idempotent per PTY. Never throws.
 */
export function terminatePty(
  pty: TerminablePty,
  opts: TerminatePtyOptions = {},
): Promise<void> {
  const existing = inFlight.get(pty);
  if (existing) return existing;
  const done = escalate(pty, opts);
  inFlight.set(pty, done);
  exiting.set(done, opts.label ?? `pid ${pty.pid}`);
  void done.then(() => exiting.delete(done));
  return done;
}

/**
 * Wait (bounded) for every PTY being terminated to exit. Resolves with the
 * labels of those still running at the cap (empty = all exited).
 */
export async function awaitPtyExits(capMs: number): Promise<string[]> {
  if (exiting.size > 0) {
    await new Promise<void>((resolve) => {
      const cap = setTimeout(resolve, capMs);
      void Promise.all([...exiting.keys()]).then(() => {
        clearTimeout(cap);
        resolve();
      });
    });
  }
  return [...exiting.values()];
}

function escalate(
  pty: TerminablePty,
  opts: TerminatePtyOptions,
): Promise<void> {
  const {
    termAfterMs = PTY_TERM_AFTER_MS,
    killAfterMs = PTY_KILL_AFTER_MS,
    signal = (pid, sig) => process.kill(pid, sig),
    label = `pid ${pty.pid}`,
  } = opts;
  const timers: NodeJS.Timeout[] = [];
  // Once the group is gone (ESRCH) or the leader has exited, nothing more is
  // sent — including stages armed AFTER that (the first SIGHUP can already
  // find the group gone, before the later stages exist).
  let stopped = false;
  const cancel = () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };

  const send = (sig: NodeJS.Signals): void => {
    if (stopped) return;
    // Windows has no process groups; node-pty's own kill is all there is.
    if (process.platform === "win32") {
      if (sig !== "SIGHUP") return;
      try {
        pty.kill();
      } catch (err) {
        console.warn(
          `[pty] kill failed for ${label}: ${(err as Error).message}`,
        );
      }
      return;
    }
    try {
      signal(-pty.pid, sig);
    } catch (err) {
      // ESRCH: the group is gone — stop. Never fall back to the bare pid
      // (see PID-reuse above). Anything else: log; the next stage retries.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        cancel();
        return;
      }
      console.warn(
        `[pty] ${sig} to ${label}'s process group failed: ${(err as Error).message}`,
      );
    }
  };
  const sendAfter = (ms: number, sig: NodeJS.Signals): void => {
    const t = setTimeout(() => send(sig), ms);
    t.unref();
    timers.push(t);
  };

  const done = new Promise<void>((resolve) => {
    const sub = pty.onExit(() => {
      // Cancelling the pending stages IS the PID-reuse guard.
      cancel();
      sub.dispose();
      if (process.platform !== "win32") reportStragglers(pty.pid, label);
      resolve();
    });
  });

  if (opts.label && process.platform !== "win32") {
    const n = groupSize(pty.pid);
    if (n !== undefined && n > 1) {
      console.log(
        `[pty] stopping ${label}: its process group has ${n} processes (the agent CLI + ${n - 1} more, e.g. its MCP servers)`,
      );
    }
  }
  send("SIGHUP");
  sendAfter(termAfterMs, "SIGTERM");
  sendAfter(killAfterMs, "SIGKILL");
  return done;
}

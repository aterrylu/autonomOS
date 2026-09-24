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
 * `killAfterMs`. The group signal reaches every process still in the agent's
 * group (MCP servers, relaunched children). It does NOT reach work the agent
 * put in a group of its own: measured, Claude Code's Bash tool runs each
 * command in a separate process group, so `nohup … &` from an agent is out of
 * reach here (and, reparented to init, of any kill) — by design of the tool.
 *
 * PID-reuse safety: nothing is signalled once the PTY's onExit has fired —
 * every pending escalation stage is cancelled on exit. After the leader is
 * reaped its pid can be reused, and a later `-pid` could name an unrelated
 * group.
 */

import { execFileSync } from "node:child_process";
import type { IPty } from "node-pty";

export const PTY_TERM_AFTER_MS = 250;
export const PTY_KILL_AFTER_MS = 2_000;

export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

export interface TerminatePtyOptions {
  termAfterMs?: number;
  killAfterMs?: number;
  /** Injected for tests; defaults to process.kill. */
  signal?: SignalFn;
  /** Names the agent in the kill log line. */
  label?: string;
}

/**
 * pgid of every process, from one `ps`. Reused for a short window so a burst of
 * kills (shutdown, restart-all: one per agent) costs a single `ps`, not one per
 * agent on the event loop.
 */
let pgidTable: { at: number; pgids: number[] } | undefined;
const PGID_TABLE_TTL_MS = 500;

/**
 * How many processes are in the group right now, or undefined if it can't be
 * read. Logged at kill time so the operator can see what a group kill took
 * with it beyond the agent CLI (MCP servers, anything left in its group).
 */
function groupSize(pgid: number): number | undefined {
  const now = Date.now();
  if (!pgidTable || now - pgidTable.at > PGID_TABLE_TTL_MS) {
    try {
      const pgids = execFileSync("ps", ["-axo", "pgid="], { encoding: "utf8" })
        .split("\n")
        .map((l) => Number(l.trim()));
      pgidTable = { at: now, pgids };
    } catch {
      return undefined;
    }
  }
  return pgidTable.pgids.filter((g) => g === pgid).length;
}

type TerminablePty = Pick<IPty, "pid" | "onExit" | "kill">;

/** One escalation per PTY: a kill followed by shutdown reuses the first. */
const inFlight = new WeakMap<TerminablePty, Promise<void>>();
/** Every PTY between terminatePty() and its exit — what shutdown waits on. */
const exiting = new Set<Promise<void>>();

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
  exiting.add(done);
  void done.then(() => exiting.delete(done));
  return done;
}

/**
 * Wait (bounded) for every PTY being terminated to exit. Resolves with how
 * many had not exited at the cap.
 */
export async function awaitPtyExits(capMs: number): Promise<number> {
  if (exiting.size > 0) {
    await new Promise<void>((resolve) => {
      const cap = setTimeout(resolve, capMs);
      void Promise.all([...exiting]).then(() => {
        clearTimeout(cap);
        resolve();
      });
    });
  }
  return exiting.size;
}

function escalate(
  pty: TerminablePty,
  opts: TerminatePtyOptions,
): Promise<void> {
  const {
    termAfterMs = PTY_TERM_AFTER_MS,
    killAfterMs = PTY_KILL_AFTER_MS,
    signal = (pid, sig) => process.kill(pid, sig),
  } = opts;
  const timers: NodeJS.Timeout[] = [];

  const send = (sig: NodeJS.Signals): void => {
    // Windows has no process groups; node-pty's own kill is all there is.
    if (process.platform === "win32") {
      if (sig === "SIGHUP") pty.kill();
      return;
    }
    try {
      signal(-pty.pid, sig);
    } catch (err) {
      // ESRCH: no group by that id (the leader left it, or it's already
      // empty) — fall back to the leader alone. Anything else: log, and let
      // the next stage try again.
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        try {
          signal(pty.pid, sig);
        } catch {
          // already gone
        }
        return;
      }
      console.warn(
        `[pty] ${sig} to process group ${pty.pid} failed: ${(err as Error).message}`,
      );
    }
  };

  const done = new Promise<void>((resolve) => {
    const sub = pty.onExit(() => {
      // Cancelling the pending stages IS the PID-reuse guard: after this no
      // signal is ever sent to this pid or group.
      for (const t of timers) clearTimeout(t);
      sub.dispose();
      resolve();
    });
  });

  if (opts.label && process.platform !== "win32") {
    const n = groupSize(pty.pid);
    if (n !== undefined && n > 1) {
      console.log(
        `[pty] stopping ${opts.label}: its process group has ${n} processes (the agent CLI + ${n - 1} more, e.g. its MCP servers)`,
      );
    }
  }
  send("SIGHUP");
  for (const [ms, sig] of [
    [termAfterMs, "SIGTERM"],
    [killAfterMs, "SIGKILL"],
  ] as const) {
    const t = setTimeout(() => send(sig), ms);
    t.unref();
    timers.push(t);
  }
  return done;
}

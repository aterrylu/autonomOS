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
 * `killAfterMs`. The group signal also reaches anything the agent backgrounded
 * in its session (a dev server, `tail -f`) — the intent for kill / delete /
 * restart / shutdown.
 *
 * PID-reuse safety: nothing is signalled once the PTY's onExit has fired —
 * every pending escalation is cancelled on exit. After the leader is reaped its
 * pid can be reused, and a later `-pid` could name an unrelated group.
 */

import type { IPty } from "node-pty";

export const PTY_TERM_AFTER_MS = 250;
export const PTY_KILL_AFTER_MS = 2_000;

export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

export interface TerminatePtyOptions {
  termAfterMs?: number;
  killAfterMs?: number;
  /** Injected for tests; defaults to process.kill. */
  signal?: SignalFn;
}

/**
 * Begin terminating `pty`'s process group. Resolves when the PTY has exited.
 * Idempotency is the caller's job (one call per PTY) — a second call would
 * start a second, redundant escalation.
 */
export function terminatePty(
  pty: Pick<IPty, "pid" | "onExit">,
  opts: TerminatePtyOptions = {},
): Promise<void> {
  const {
    termAfterMs = PTY_TERM_AFTER_MS,
    killAfterMs = PTY_KILL_AFTER_MS,
    signal = (pid, sig) => process.kill(pid, sig),
  } = opts;
  let exited = false;
  const timers: NodeJS.Timeout[] = [];

  const send = (sig: NodeJS.Signals): void => {
    if (exited) return;
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
      exited = true;
      for (const t of timers) clearTimeout(t);
      sub.dispose();
      resolve();
    });
  });

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

/**
 * Sidecar daemon management for providers that run a separate backend process
 * behind the visible PTY (currently: Codex's `app-server` daemon).
 *
 * Codex's terminal-preserving inter-agent comm works by running a per-agent
 * `codex app-server --listen ws://127.0.0.1:PORT` daemon and attaching the
 * visible TUI to it via `codex --remote ws://…`. An external control client
 * (the gateway) can then inject turns into the same thread the TUI renders —
 * the native equivalent of Claude Code's "channels".
 *
 * This module owns: picking a free loopback port, spawning the daemon, waiting
 * until it is actually listening (the `--remote` TUI errors out immediately on a
 * cold port — it does NOT retry), and disposing the daemon when the agent's PTY
 * exits. One daemon per agent, lifecycle bound 1:1 to the PTY (mirrors how a
 * Claude Code pane process lives and dies with the session).
 */

import { type ChildProcess, spawn as cpSpawn } from "node:child_process";
import { createServer } from "node:net";

export interface Sidecar {
  /** The ws:// endpoint the daemon listens on (and the TUI/gateway connect to). */
  endpoint: string;
  /** The daemon child process. */
  proc: ChildProcess;
  /**
   * Kill the daemon: SIGTERM, then SIGKILL after {@link SIDECAR_KILL_AFTER_MS}.
   * Idempotent (repeat calls return the first call's promise). Resolves once
   * the daemon has actually EXITED. Callers whose process keeps running may
   * ignore it (`void`) — the escalation fires on its own; server shutdown goes
   * through {@link stopAllSidecars} instead.
   */
  dispose(): Promise<void>;
}

/**
 * How long a disposed daemon gets to honor SIGTERM before SIGKILL: a backstop
 * for a hung daemon. A healthy codex daemon exits in ~0.2s (see
 * stopAllSidecars).
 */
export const SIDECAR_KILL_AFTER_MS = 2_000;

/** Default bound on a shutdown's wait: the SIGKILL backstop plus a margin. */
export const SIDECAR_EXIT_CAP_MS = SIDECAR_KILL_AFTER_MS + 1_000;

/**
 * Every daemon process that currently exists — starting, attached, or exiting —
 * keyed by process, with its dispose(). Registered at spawn, removed on exit.
 * This, not the runtime's `live` map, is the source of truth for shutdown: a
 * daemon can exist outside `live` (still starting, or already disposed by a
 * kill / restart-all whose exit hasn't landed).
 */
const running = new Map<ChildProcess, () => Promise<void>>();

/** Pids of every daemon that has not exited yet. */
export function runningSidecarPids(): number[] {
  return [...running.keys()].flatMap((p) =>
    p.pid === undefined ? [] : [p.pid],
  );
}

/**
 * Server shutdown: dispose EVERY daemon and wait (bounded) until none is left.
 * Resolves with the pids still alive at the cap (empty = all exited).
 *
 * Why the server must wait instead of exiting straight after dispose():
 * measured on codex 0.154, when the server exited in the same tick as the
 * SIGTERM, a daemon that was mid-turn did NOT exit — it was orphaned to init
 * and ran its turn (model calls, the agent's shell commands) to completion,
 * every time. With the server alive until the daemon is gone, it exited within
 * ~0.2s. (Why codex's own shutdown stalls once its parent vanishes isn't
 * isolated.) Exiting first would also pre-empt the SIGKILL backstop, a timer in
 * this process.
 *
 * Each round re-sweeps the registry, so a daemon a racing spawn started after
 * the first sweep is disposed and waited for too.
 */
export async function stopAllSidecars(
  capMs = SIDECAR_EXIT_CAP_MS,
): Promise<number[]> {
  const deadline = Date.now() + capMs;
  while (running.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    await awaitSidecarExits(
      [...running.values()].map((dispose) => dispose()),
      left,
    );
  }
  return runningSidecarPids();
}

/**
 * Wait for disposed daemons to exit, but never longer than `capMs`. Resolves
 * `true` if every daemon exited in time. The cap timer is ref'd so the wait
 * holds the event loop open on its own.
 */
export function awaitSidecarExits(
  exits: Promise<void>[],
  capMs = SIDECAR_EXIT_CAP_MS,
): Promise<boolean> {
  if (exits.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cap = setTimeout(() => resolve(false), capMs);
    void Promise.all(exits).then(() => {
      clearTimeout(cap);
      resolve(true);
    });
  });
}

/** Pick a free TCP port on loopback by binding :0 and reading the assignment. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

export interface StartSidecarOptions {
  cwd: string;
  env: Record<string, string>;
  /** Substring on stdout/stderr that signals the daemon is listening. */
  readyNeedle: string;
  /** Max ms to wait for readiness before failing. Default 12000. */
  readyTimeoutMs?: number;
}

/**
 * Spawn a sidecar daemon and resolve once it signals readiness (or reject on
 * early exit / timeout). On any failure the child is killed before rejecting so
 * we never leak an orphaned daemon when the spawn ultimately fails.
 */
export function startSidecarDaemon(
  binary: string,
  args: string[],
  endpoint: string,
  opts: StartSidecarOptions,
): Promise<Sidecar> {
  const timeoutMs = opts.readyTimeoutMs ?? 12_000;

  return new Promise<Sidecar>((resolve, reject) => {
    let settled = false;
    // Set once we intentionally tear the daemon down, so the post-readiness
    // exit logger doesn't cry "crashed" on a normal dispose.
    let disposing = false;
    const proc = cpSpawn(binary, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Settles when the daemon is gone. A spawn failure ('error' with no pid)
    // never ran a process, so it counts as exited; a post-readiness 'error'
    // (e.g. a failed kill) does not.
    const exited = new Promise<void>((resolveExit) => {
      proc.once("exit", () => resolveExit());
      proc.once("error", () => {
        if (proc.pid === undefined) resolveExit();
      });
    });
    void exited.then(() => running.delete(proc));

    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposal ??= kill();
      return disposal;
    };
    const kill = (): Promise<void> => {
      disposing = true;
      // Already exited — nothing to do.
      if (proc.exitCode !== null || proc.signalCode !== null) return exited;
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        // ESRCH means the process is already gone — truly nothing to do.
        // Any other errno (e.g. EPERM) means it may still be ALIVE but we
        // couldn't signal it; fall through to the SIGKILL escalation rather
        // than silently abandoning a live daemon.
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return exited;
        console.warn(
          `[sidecar] SIGTERM failed for daemon pid ${proc.pid} (${
            (err as Error).message
          }) — escalating to SIGKILL`,
        );
      }
      // Escalate to SIGKILL if the daemon doesn't exit promptly, so a stuck
      // daemon never lingers and holds its port. The timer is unref'd so it
      // never keeps the server alive on its own (hence stopAllSidecars at
      // shutdown), and is cleared the moment the daemon exits.
      const escalate = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, SIDECAR_KILL_AFTER_MS);
      escalate.unref();
      proc.once("exit", () => clearTimeout(escalate));
      return exited;
    };
    if (proc.pid !== undefined) running.set(proc, dispose);

    const onReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", scan);
      proc.stderr?.off("data", scan);
      proc.off("exit", onExit);
      proc.off("error", onError);
      // Keep a benign handler on `error`/`exit` for the daemon's whole life.
      // Without a listener, a post-readiness 'error' event would throw as an
      // uncaught exception and crash the entire server. A post-readiness exit
      // (daemon crashed mid-session) is logged so it's diagnosable instead of
      // surfacing only as a mysteriously-dead TUI; the PTY's onExit handles the
      // dispose (a no-op here since the daemon is already gone).
      proc.on("error", (err) =>
        console.warn(
          `[sidecar] daemon ${endpoint} emitted error post-readiness:`,
          err.message,
        ),
      );
      proc.once("exit", (code, signal) => {
        if (disposing) return; // normal teardown — not a crash
        console.warn(
          `[sidecar] daemon ${endpoint} exited post-readiness (code=${code} signal=${signal ?? "none"})`,
        );
      });
      resolve({ endpoint, proc, dispose });
    };

    // Accumulate output: the "listening on" banner can straddle two `data`
    // chunks (pipes aren't line-buffered), and testing each chunk in isolation
    // would miss the needle → a false readiness timeout that kills a healthy
    // daemon. Cap the buffer so a chatty daemon can't grow it unbounded.
    let scanBuf = "";
    const scan = (chunk: Buffer) => {
      scanBuf += chunk.toString();
      if (scanBuf.includes(opts.readyNeedle)) {
        onReady();
        return;
      }
      const cap = opts.readyNeedle.length + 256;
      if (scanBuf.length > cap) scanBuf = scanBuf.slice(-cap);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void dispose();
      reject(err);
    };

    const onExit = (code: number | null, signal: string | null) =>
      fail(
        new Error(
          `sidecar daemon exited before readiness (code=${code} signal=${signal ?? "none"})`,
        ),
      );
    const onError = (err: Error) =>
      fail(new Error(`sidecar daemon failed to spawn: ${err.message}`));

    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `sidecar daemon did not signal readiness ("${opts.readyNeedle}") within ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );

    proc.stdout?.on("data", scan);
    proc.stderr?.on("data", scan);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

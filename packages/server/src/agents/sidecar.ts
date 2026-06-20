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
  /** Kill the daemon. Idempotent. */
  dispose(): void;
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

    const dispose = () => {
      disposing = true;
      // Already exited — nothing to do.
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      try {
        proc.kill("SIGTERM");
      } catch (err) {
        // ESRCH means the process is already gone — truly nothing to do.
        // Any other errno (e.g. EPERM) means it may still be ALIVE but we
        // couldn't signal it; fall through to the SIGKILL escalation rather
        // than silently abandoning a live daemon.
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        console.warn(
          `[sidecar] SIGTERM failed for daemon pid ${proc.pid} (${
            (err as Error).message
          }) — escalating to SIGKILL`,
        );
      }
      // Escalate to SIGKILL if the daemon doesn't exit promptly, so a stuck
      // daemon never lingers and holds its port. The timer is unref'd so it
      // never keeps the server process alive on its own, and is cleared the
      // moment the daemon actually exits.
      const kill = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2_000);
      kill.unref();
      proc.once("exit", () => clearTimeout(kill));
    };

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
      dispose();
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

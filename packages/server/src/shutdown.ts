/**
 * The server's SIGINT/SIGTERM handler, factored out of `runServer` so its
 * ordering is testable: tear down agents, wait (bounded) for their sidecar
 * daemons to exit, then exit. See stopAllSidecars for why the wait matters.
 */

export interface ShutdownSteps {
  /** Stop timers that could start new work (the scheduler). */
  stopWork(): void;
  /** Tear down every agent (synchronous; daemons are signalled, not awaited). */
  teardownAgents(): void;
  /** Wait (bounded) for every sidecar daemon to exit; resolves with the pids
   *  still alive at the bound. */
  awaitDaemons(): Promise<number[]>;
  /** Release the pid file + control socket and exit. Called exactly once. */
  exitProcess(): void;
  /**
   * A repeat signal inside this window is the SAME request delivered twice,
   * not an impatient user: Ctrl+C signals the whole foreground process group,
   * so a runner wrapping the server (tsx, bun, make) can forward a copy on top
   * of the one the server already got. Only a repeat after it means "now".
   */
  repeatGraceMs?: number;
  /**
   * Where uncaught errors are reported (default: `process`). Injected by tests
   * so they never install handlers on the real process.
   */
  processEvents?: Pick<NodeJS.EventEmitter, "on">;
}

/** Errors logged in full during shutdown; later ones are only counted. */
const MAX_LOGGED_SHUTDOWN_ERRORS = 5;

export function createShutdownHandler(steps: ShutdownSteps): () => void {
  const repeatGraceMs = steps.repeatGraceMs ?? 1_000;
  let startedAt: number | undefined;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    steps.exitProcess();
  };
  // Once shutdown has started, an uncaught error must not end the process
  // early: the teardown's SIGTERM/SIGKILL stages and the sidecar daemons'
  // second SIGTERM are timers in THIS process, and the exit is already coming
  // (bounded) from awaitDaemons. Measured: a log write to a closed pipe
  // (`server | tee`, tee killed by the same Ctrl-C) raised an uncaught EPIPE
  // right after the first shutdown log line and killed the server before any
  // of them fired. Armed first, before anything in the handler can throw.
  let swallowed = 0;
  const survive = (err: unknown): void => {
    swallowed += 1;
    if (swallowed > MAX_LOGGED_SHUTDOWN_ERRORS) return; // may be the log itself failing
    try {
      console.error(
        `[shutdown] uncaught error during shutdown — continuing so agents are still stopped:`,
        err,
      );
    } catch {
      // Logging is best effort here; the stages must still run.
    }
  };
  const armGuard = (): void => {
    const events = steps.processEvents ?? process;
    events.on("uncaughtException", survive);
    events.on("unhandledRejection", survive);
  };
  const attempt = (label: string, step: () => void): void => {
    try {
      step();
    } catch (err) {
      console.error(`[shutdown] ${label} threw:`, err);
    }
  };
  return () => {
    if (startedAt !== undefined) {
      if (Date.now() - startedAt < repeatGraceMs) return;
      console.warn(
        "Second shutdown signal — exiting without waiting for agent daemons.",
      );
      exitOnce();
      return;
    }
    startedAt = Date.now();
    armGuard();
    attempt("logging", () =>
      console.log(
        "Shutting down — killing PTYs (agents will resume on next start)...",
      ),
    );
    // A throw in either step must not strand the process: log it and still
    // wait for whatever daemons were signalled, then exit.
    attempt("stopping work", steps.stopWork);
    attempt("agent teardown", steps.teardownAgents);
    steps
      .awaitDaemons()
      .then((survivors) => {
        if (survivors.length > 0) {
          console.warn(
            `[shutdown] agent daemon(s) still alive after SIGKILL (pid ${survivors.join(", ")}) — they may outlive the server`,
          );
        }
      })
      .catch((err) => console.error("[shutdown] daemon wait threw:", err))
      .finally(exitOnce);
  };
}

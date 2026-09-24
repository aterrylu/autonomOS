/**
 * The server's SIGINT/SIGTERM handler, factored out of `runServer` so its
 * ordering is testable without booting a server.
 *
 * The ordering is the point: tear down the agents, WAIT (bounded) for their
 * sidecar daemons to exit, and only then exit. Exiting in the same tick as the
 * teardown orphaned any Codex daemon that was mid-turn: it did not exit on the
 * SIGTERM, but ran the agent's turn — model calls, tool calls, file writes —
 * to completion with no server above it (measured on codex 0.154, every run).
 * Kept alive until the daemon is gone, the server sees it exit in ~0.2s; the
 * SIGKILL backstop covers one that hangs. See awaitSidecarExits.
 */

import { awaitSidecarExits } from "./agents/sidecar.js";

export interface ShutdownSteps {
  /** Stop timers that could start new work (the scheduler). */
  stopWork(): void;
  /** Tear down every agent; returns one exit promise per sidecar daemon. */
  teardownAgents(): Promise<void>[];
  /** Release the pid file + control socket and exit. Called exactly once. */
  exitProcess(): void;
  /** Override the wait cap (tests). Default: SIGKILL escalation + margin. */
  capMs?: number;
}

export function createShutdownHandler(steps: ShutdownSteps): () => void {
  let stopping = false;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    steps.exitProcess();
  };
  return () => {
    // A second signal while we wait on the daemons means "now".
    if (stopping) {
      console.warn(
        "Second shutdown signal — exiting without waiting for agent daemons.",
      );
      exitOnce();
      return;
    }
    stopping = true;
    console.log(
      "Shutting down — killing PTYs (agents will resume on next start)...",
    );
    steps.stopWork();
    void awaitSidecarExits(steps.teardownAgents(), steps.capMs).then(
      (allExited) => {
        if (!allExited) {
          console.warn(
            "[shutdown] an agent daemon had not exited after SIGKILL — it may outlive the server",
          );
        }
        exitOnce();
      },
    );
  };
}

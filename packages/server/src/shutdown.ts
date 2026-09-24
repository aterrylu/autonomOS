/**
 * The server's SIGINT/SIGTERM handler, factored out of `runServer` so its
 * ordering is testable without booting a server.
 *
 * The ordering is the point: tear down the agents, WAIT (bounded) for their
 * sidecar daemons to exit, and only then exit. A Codex app-server daemon
 * mid-turn treats SIGTERM as "drain" and keeps running the turn; its SIGKILL
 * escalation is a timer in this process. Exiting in the same tick as the
 * teardown pre-empted that timer, orphaning the daemon to init where it kept
 * executing the agent's turn — model calls, tool calls, file writes — with no
 * server above it.
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

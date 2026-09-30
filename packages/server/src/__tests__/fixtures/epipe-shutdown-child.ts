/**
 * Child process for shutdown-epipe.test.ts: the server's real logger and
 * shutdown handler, with stdout piped to a parent that closes its read end —
 * `server | tee` with tee killed. Progress goes to $MARKER_FILE (sync appends,
 * never stdout), so the parent can tell how far shutdown got.
 *
 * EPIPE_MODE:
 *   file     — initFileLogging() succeeds (the normal server)
 *   nofile   — initFileLogging() runs but can't open its log file
 *   nologger — initFileLogging() never runs: only the shutdown guard remains
 */

import { appendFileSync } from "node:fs";
import { initFileLogging } from "../../logger.js";
import { createShutdownHandler } from "../../shutdown.js";

const marker = (m: string) =>
  appendFileSync(process.env.MARKER_FILE as string, `${m}\n`);

if (process.env.EPIPE_MODE !== "nologger") initFileLogging();

const handler = createShutdownHandler({
  stopWork: () => {},
  teardownAgents: () => {
    marker("teardown");
    console.log("[child] tearing down");
  },
  // Stands in for the timed stages (the PTY SIGTERM at 250ms, the sidecar
  // daemons' second SIGTERM): a timer that must still fire.
  awaitDaemons: () =>
    new Promise((resolve) =>
      setTimeout(() => {
        marker("escalation");
        console.log("[child] escalation stage");
        resolve([]);
      }, 400),
    ),
  exitProcess: () => {
    marker("exit");
    process.exit(0);
  },
});
process.on("SIGTERM", handler);

// Each line on stdin makes the child log once — after the parent has closed
// stdout's read end, that write fails with EPIPE.
process.stdin.on("data", () => {
  console.log("[child] a log line after the reader went away");
  marker("logged");
});

console.log("[child] ready");
marker("ready");

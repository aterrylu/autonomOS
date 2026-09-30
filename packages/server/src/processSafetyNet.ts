/**
 * Last-resort handler for promise rejections nobody awaited.
 *
 * Node's default for an unhandled rejection is to terminate the process. For
 * this server that means every agent PTY and every turn in flight dies with
 * it, and security audit V6 showed the trigger was reachable by any agent: one
 * malformed /ws/gateway frame threw inside an async WebSocket handler, which
 * the WS library only guards synchronously.
 *
 * The gateway handler now validates frames and catches its own errors. This is
 * the net under every OTHER async callback with the same shape: log the
 * rejection loudly and keep serving. A rejection is a failed async operation,
 * not corrupted synchronous state, so continuing is safe in a way it is not
 * for `uncaughtException`, which keeps Node's default (crash, and the service
 * manager restarts us).
 *
 * Installed only once the server is up: a rejection during boot should still
 * fail the boot rather than leave a half-started server running.
 */

let installed = false;

export function installUnhandledRejectionLogger(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[server] unhandled promise rejection (logged, server kept running). " +
        "This is a bug: the code that started this promise should handle it.",
      reason,
    );
  });
}

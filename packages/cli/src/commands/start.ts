// `autonomos start` — run the server in the foreground.
//
// This is a thin wrapper around the server's runServer() function. Forwards
// argv flags (--port, --embedded) untouched so existing invocation patterns
// work identically:
//
//   autonomos start --port=3100
//   autonomos start --embedded            (used by Phase 1B Electron)
//   autonomos --port=3100                 (no subcommand; treated as start)
//
// We do NOT spawn a child process here — the CLI binary IS the server when
// `start` is invoked. This is the same pattern caddy/redis-server use:
// running them with no args (or with `run`/`server` subcommand) starts the
// server in-process.

import { runServer } from "@autonomos/server/run.js";

export async function runStartCommand(argv: readonly string[]): Promise<void> {
  await runServer(argv);
}

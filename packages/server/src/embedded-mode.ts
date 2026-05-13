// Embedded-mode integration for the autonomos-server binary.
//
// Embedded mode = the server is being spawned by a parent process (typically
// the Electron desktop app) rather than running standalone. It changes three
// things vs standalone:
//
//   1. Bind to 127.0.0.1 only (never network-exposed; the parent is local).
//   2. Emit a structured readiness signal on stdout once the listener is up
//      so the parent can parse the actual port (necessary when --port=0
//      asks the OS to pick a free port). The contract is:
//          AUTONOMOS_READY port=<N>\n
//      This is the *only* line the parent should pattern-match. Other log
//      lines are for humans.
//   3. SIGTERM is the canonical "please quit" signal from the parent. The
//      existing shutdown() in index.ts already traps SIGTERM, so this module
//      only needs to ensure the bind host change and the stdout signal.
//
// Standalone mode (no --embedded flag) keeps current behavior: binds to the
// default node interface (effectively 0.0.0.0) for LAN reachability, no
// structured stdout signal.

export type EmbeddedConfig = {
  /** The hostname/interface to pass to @hono/node-server's serve(). */
  bindHost: string | undefined;
};

/**
 * Resolve embedded-mode configuration from the parsed CLI flags.
 *
 * When embedded is true:
 *   - bindHost = "127.0.0.1" (localhost only)
 * When embedded is false:
 *   - bindHost = undefined (let serve() use its default)
 */
export function resolveEmbeddedConfig(embedded: boolean): EmbeddedConfig {
  return {
    bindHost: embedded ? "127.0.0.1" : undefined,
  };
}

/**
 * Emit the structured readiness signal that the parent process (Electron)
 * pattern-matches on. Call this AFTER serve()'s listening callback fires,
 * because when --port=0 is used the actual port is only known then.
 *
 * Stdout (not stderr) so parents using { stdio: ['ignore', 'pipe', 'inherit'] }
 * pick it up while letting log output flow through naturally.
 */
export function announceEmbeddedReady(actualPort: number): void {
  process.stdout.write(`AUTONOMOS_READY port=${actualPort}\n`);
}

/**
 * Runtime server state — single source of truth for "what port am I on?" and
 * "what's my auth token?", set once at boot in `run.ts` and read by code paths
 * that spawn child processes which need to dial back to this server.
 *
 * Before this module existed, spawn-time code read `process.env.PORT || "3000"`
 * to compute the URL given to Claude Code sessions. That broke Built-in (embedded)
 * mode: the Desktop spawned the server with `--port=0` (OS-assigned ephemeral
 * port), the server bound successfully but never reflected the actual port back
 * into `process.env.PORT`, so every spawned session got `localhost:3000` baked
 * into its hook URL and MCP gateway URL — pointing at a port nothing was
 * listening on. Hook curls fail silently (`-sf >/dev/null 2>&1`), MCP WebSocket
 * retries forever. The dashboard goes blind on telemetry, MCP tools don't work.
 */

let _port: number | null = null;
let _token: string | null = null;

export function setServerPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`setServerPort: invalid port ${port}`);
  }
  _port = port;
}

export function getServerPort(): number {
  if (_port === null) {
    throw new Error(
      "getServerPort() called before setServerPort() — server has not finished listen() yet.",
    );
  }
  return _port;
}

export function setAuthToken(token: string): void {
  if (!token) throw new Error("setAuthToken: token must be non-empty");
  _token = token;
}

export function getAuthToken(): string {
  if (_token === null) {
    throw new Error(
      "getAuthToken() called before setAuthToken() — server boot has not resolved the token yet.",
    );
  }
  return _token;
}

/** Test-only — reset module state between tests. */
export function _resetServerStateForTesting(): void {
  _port = null;
  _token = null;
}

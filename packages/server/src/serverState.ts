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
let _internalSocketPath: string | null = null;

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

/**
 * Publish the path of the internal control-plane Unix socket (ADR-055).
 *
 * Set once, inside the public listener's "we own this config dir" branch, after
 * the internal listener has actually bound — so a reader can treat a successful
 * return as "the socket exists and is accepting connections". Spawn-time code
 * (providers/*, shared.ts) bakes this into agent env as AUTONOMOS_INTERNAL_SOCKET.
 */
export function setInternalSocketPath(path: string): void {
  if (!path) throw new Error("setInternalSocketPath: path must be non-empty");
  _internalSocketPath = path;
}

/**
 * Thrown when something needs the control plane before it has bound.
 *
 * This is a TRANSIENT startup condition, not a bug, which is why it is typed:
 * the public HTTP listener starts answering BEFORE the socket binds (it binds
 * first, then pid-file arbitration runs, then the socket binds — see run.ts
 * armRuntimeInits). A spawn arriving in that window would otherwise produce an
 * agent whose hook relay points at a socket that does not exist yet.
 *
 * Typed so the routes' central onError can map it to an actionable 503 +
 * Retry-After instead of leaking an internal invariant string as a 500. Every
 * spawn path funnels through buildBaseEnv → getInternalSocketPath(), so this
 * covers POST /api/agents, /:id/attach, /restart-all — and any spawn route
 * added later — without each having to remember a guard.
 */
export class ControlPlaneNotReadyError extends Error {
  readonly code = "CONTROL_PLANE_NOT_READY";
  constructor() {
    super(
      "The internal control plane is still starting up — the agent hook " +
        "socket has not bound yet. This clears within a moment of boot; retry.",
    );
    this.name = "ControlPlaneNotReadyError";
  }
}

export function getInternalSocketPath(): string {
  if (_internalSocketPath === null) {
    throw new ControlPlaneNotReadyError();
  }
  return _internalSocketPath;
}

/** Test-only — reset module state between tests. */
export function _resetServerStateForTesting(): void {
  _port = null;
  _token = null;
  _internalSocketPath = null;
}

import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Trusted-proxy mode for `tailscale serve` (ADR-140).
 *
 * Behind `tailscale serve` every visitor reaches autonomOS from this machine
 * (TCP peer 127.0.0.1), so per-device protections (throttle, new-device lock,
 * known devices) would treat all of them as "this machine", which is exempt.
 * Measured on Tailscale 1.102.3: tailscaled adds X-Forwarded-For with the
 * visitor's tailnet IP (always, including tagged nodes) and, for user-owned
 * nodes, Tailscale-User-Login; it OVERWRITES any such header the visitor sent.
 *
 * With `--trust-proxy=tailscale` (opt-in), autonomOS also listens on an
 * OWNER-ONLY unix socket for `tailscale serve --bg unix:<path>` (ADR-153):
 *  - A request on that socket came from tailscaled: only it (root, or the
 *    App Store extension running as the operator) can connect. Identity = its
 *    X-Forwarded-For (exactly ONE valid IP, else 400), login = context.
 *  - Loopback TCP is this machine (the CLI, a local dashboard), and its
 *    headers are NEVER trusted: a TCP peer carries no uid, so any local user
 *    could have sent them (SecurityAudit, #488). A loopback TCP request that
 *    CARRIES Tailscale identity headers means serve still points at the port;
 *    it's refused (400, naming the socket command) rather than let every
 *    tailnet visitor count as this machine, which would disable the lock.
 *  - Any other peer → its TCP address; headers never read.
 * Off (the default): the headers are never read, and there is no socket.
 *
 * Trust-proxy still requires a loopback-only TCP bind (boot refuses a network
 * bind): the LAN must not reach autonomOS around serve.
 */

export type TrustProxyMode = "off" | "tailscale";

export function parseTrustProxy(raw: string | undefined): TrustProxyMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off" || v === "none") return "off";
  if (v === "tailscale") return "tailscale";
  throw new Error(
    `Unknown --trust-proxy value "${raw}": use "tailscale" (or omit it).`,
  );
}

let mode: TrustProxyMode = "off";
export function setTrustProxyMode(m: TrustProxyMode): void {
  mode = m;
}
export function getTrustProxyMode(): TrustProxyMode {
  return mode;
}

/** Connections accepted on the serve socket (marked on "connection", before
 *  any request is parsed, so a request can't claim the mark). */
const serveConnections = new WeakSet<object>();
export function markServeConnection(socket: object): void {
  serveConnections.add(socket);
}

/** `tailscale serve --bg unix:<path>` for this install, once the socket path is
 *  known: the startup log, `token status` and the TCP refusal all print it. */
let serveCommand: string | undefined;
export function setServeSocketPath(path: string | undefined): void {
  serveCommand = path ? `tailscale serve --bg unix:${path}` : undefined;
}
export function getServeCommand(): string | undefined {
  return serveCommand;
}

export type IdentityError = {
  error: string;
  code: "BAD_PROXY_HEADER" | "SERVE_NOT_ON_SOCKET";
};

export type ClientIdentity = {
  /** The device's address: the visitor's tailnet IP when proxied. */
  address: string;
  via: "direct" | "local" | "tailscale-serve";
  /** Tailscale-User-Login, when proxied from a user-owned node. Context for
   *  the operator only: never used to authenticate anything. */
  login?: string;
};

function socketPeer(c: Context): string {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  const a = env?.incoming?.socket?.remoteAddress;
  if (!a) return "unknown";
  return a.toLowerCase().startsWith("::ffff:") && !a.slice(7).includes(":")
    ? a.slice(7)
    : a;
}

export function isLoopbackPeer(a: string): boolean {
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/** Printable, short: it ends up in a log line. */
function cleanLogin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 100)
    .trim();
  return s || undefined;
}

/**
 * Who is this request from? Returns `{ error }` for a proxied request whose
 * X-Forwarded-For isn't exactly one IP (tailscaled always sends one, so that
 * is something else on this machine misbehaving).
 */
export function clientIdentity(
  c: Context,
  m: TrustProxyMode = mode,
): ClientIdentity | IdentityError {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)
    ?.incoming;
  if (m === "tailscale" && incoming && serveConnections.has(incoming.socket))
    return serveIdentity(c);
  const peer = socketPeer(c);
  if (!isLoopbackPeer(peer)) return { address: peer, via: "direct" };
  if (
    m === "tailscale" &&
    (c.req.header("X-Forwarded-For") !== undefined ||
      c.req.header("Tailscale-User-Login") !== undefined)
  )
    return {
      error: `This request came through tailscale serve over TCP, which autonomOS doesn't trust: any program on this machine could send the same headers. Point tailscale serve at autonomOS's socket instead: ${serveCommand ?? "run `autonomos token status` for the command"}`,
      code: "SERVE_NOT_ON_SOCKET",
    };
  return { address: peer, via: "local" };
}

/** A request tailscaled forwarded over the serve socket. */
function serveIdentity(c: Context): ClientIdentity | IdentityError {
  const xff = c.req.header("X-Forwarded-For");
  const ip = (xff ?? "").trim();
  if (ip.includes(",") || isIP(ip) === 0)
    return {
      error:
        "A request on the tailscale serve socket must carry exactly one X-Forwarded-For address",
      code: "BAD_PROXY_HEADER",
    };
  const unwrapped =
    ip.toLowerCase().startsWith("::ffff:") && !ip.slice(7).includes(":")
      ? ip.slice(7)
      : ip;
  return {
    address: unwrapped,
    via: "tailscale-serve",
    login: cleanLogin(c.req.header("Tailscale-User-Login")),
  };
}

/** The device address for per-device protections (falls back to the TCP
 *  peer if the identity is invalid; the middleware refuses those first). */
export function clientAddress(c: Context): string {
  const id = clientIdentity(c);
  return "error" in id ? socketPeer(c) : id.address;
}

/** Refuse a malformed proxied identity before anything else looks at it. */
export function trustProxyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const id = clientIdentity(c);
    if ("error" in id) return c.json({ error: id.error, code: id.code }, 400);
    return next();
  };
}

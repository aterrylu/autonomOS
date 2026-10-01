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
 * With `--trust-proxy=tailscale` (opt-in):
 *  - TCP peer is loopback AND X-Forwarded-For is present → proxied. Identity =
 *    that address (exactly ONE valid IP, or the request is refused 400).
 *  - TCP peer is loopback, no X-Forwarded-For → this machine (the CLI, a local
 *    dashboard), trusted exactly as before.
 *  - Any other peer → identified by its TCP address; the headers are NEVER
 *    read, so nobody on the network can claim to be someone else.
 * Off (the default): the headers are never read.
 *
 * The mode is only safe when autonomOS listens on loopback alone (otherwise
 * a LAN peer reaches it around serve); boot refuses the combination.
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
): ClientIdentity | { error: string } {
  const peer = socketPeer(c);
  if (!isLoopbackPeer(peer)) return { address: peer, via: "direct" };
  if (m !== "tailscale") return { address: peer, via: "local" };
  const xff = c.req.header("X-Forwarded-For");
  if (xff === undefined) return { address: peer, via: "local" };
  const ip = xff.trim();
  if (ip.includes(",") || isIP(ip) === 0)
    return {
      error:
        "X-Forwarded-For must be exactly one address when autonomOS trusts tailscale serve",
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
    if ("error" in id)
      return c.json({ error: id.error, code: "BAD_PROXY_HEADER" }, 400);
    return next();
  };
}

import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
/**
 * Several bind addresses for the public listener (ADR-139, extends ADR-054).
 *
 * `--host` / AUTONOMOS_HOST may be a comma-separated list, e.g.
 * `127.0.0.1,100.101.102.103` or `127.0.0.1,dev-box` (a MagicDNS name):
 *  - the FIRST address is bound exactly as a single `--host` always was, so
 *    keep it loopback: the `autonomos` CLI, the install health check and the
 *    pid-file liveness probe all talk to the server on localhost;
 *  - every further address gets its own listener on the same port, serving
 *    the same app (same routes, CSRF guard, auth, throttle, new-device lock).
 *    If an address isn't up yet (Tailscale still starting at boot), that
 *    listener retries in the background until it is, re-resolving a name each
 *    time. A restart never fails on it, and loopback is up at once.
 * This is what makes "reachable on the tailnet only" safe across restarts.
 */

export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/** The list, or undefined for "all interfaces" (nothing set). Each entry has a
 *  surrounding quote pair peeled (a habitual `.env` quoting mistake). */
export function parseBindHosts(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const hosts = raw
    .split(",")
    .map((h) => stripQuotes(h.trim()))
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/** Reachable from other machines: no host (all interfaces), or any entry that
 *  isn't loopback. */
export function isNetworkBind(hosts: readonly string[] | undefined): boolean {
  return !hosts || hosts.some((h) => !isLoopbackHost(h));
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value[value.length - 1] === value[0]
  )
    return value.slice(1, -1).trim();
  return value;
}

const IN_USE_REPEAT_MS = 60_000;

/** The pid listening on host:port, via lsof (macOS/Linux); undefined if it
 *  can't tell. Best effort only: it names the process in a warning. */
export function lsofOwner(host: string, port: number): number | undefined {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP@${host}:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Listen errors worth retrying: the address or name isn't there YET. */
const RETRYABLE = new Set([
  "EADDRNOTAVAIL", // an IP no interface carries yet
  "ENOTFOUND", // a name that doesn't resolve yet (MagicDNS before Tailscale)
  "EAI_AGAIN",
  "EADDRINUSE", // another process holds it right now
]);

/**
 * Keep an extra listener trying until it binds. Logs at most twice: once when
 * it starts waiting, once when it binds. Returns a stop() for shutdown.
 * `server` is any Node http.Server (the adaptor server for the same app).
 */
/** The four methods keepListening uses (http, https or the http2 adaptor). */
export interface Listenable {
  listen(port: number, host: string): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: Node's EventEmitter signature
  once(event: string, fn: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: Node's EventEmitter signature
  removeListener(event: string, fn: (...args: any[]) => void): unknown;
  close(): unknown;
  /** Where it actually bound (Node's server.address()), to check a name. */
  address?(): unknown;
}

/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscaleAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a.startsWith("fd7a:115c:a1e0:")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a);
  return (
    !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127
  );
}

export function keepListening(o: {
  server: Listenable;
  host: string;
  port: number;
  intervalMs?: number;
  log?: (line: string) => void;
  /** Where the address-in-use SECURITY warning goes (console.warn). */
  warn?: (line: string) => void;
  now?: () => number;
  /** Best-effort pid of whoever holds host:port (lsof), for that warning. */
  ownerOf?: (host: string, port: number) => number | undefined;
  /** This process's pid (to tell a self-collision from a squatter). */
  selfPid?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): { stop: () => void } {
  const log = o.log ?? console.log;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer =
    o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const interval = o.intervalMs ?? 5_000;
  const warn = o.warn ?? console.warn;
  const now = o.now ?? Date.now;
  let waitingLogged = false;
  let inUse = false;
  let lastInUseWarn = Number.NEGATIVE_INFINITY;
  let selfChecked = false;
  let stopped = false;
  let timer: unknown;

  const attempt = () => {
    if (stopped) return;
    const onError = (err: NodeJS.ErrnoException) => {
      o.server.removeListener("listening", onListening);
      if (stopped) return;
      if (!RETRYABLE.has(err.code ?? "")) {
        log(
          `[bind] can't listen on ${o.host}:${o.port} (${err.code ?? err.message}); not retrying`,
        );
        return;
      }
      if (err.code === "EADDRINUSE") {
        // NOT "not up yet": another process is SERVING this address, and a
        // device that opens it reaches that process, possibly a fake sign-in
        // page collecting the token (SecurityAudit, #480). Loud, repeated at
        // most once a minute while it lasts, with the owner when known.
        // The owner lookup (lsof) is synchronous and can take seconds, so it
        // runs only when its answer is used: once on the FIRST collision (a
        // self-collision ends for good) and when the throttled warning fires,
        // never on every retry (nox, #480).
        let owner: number | undefined;
        let looked = false;
        const lookup = () => {
          if (!looked) {
            looked = true;
            owner = o.ownerOf?.(o.host, o.port);
          }
          return owner;
        };
        if (!selfChecked) {
          selfChecked = true;
          lookup();
        }
        if (owner !== undefined && owner === (o.selfPid ?? process.pid)) {
          // Not a squatter: another of autonomOS's OWN --host entries already
          // covers this address (localhost = 127.0.0.1, a duplicate, or a
          // wildcard like 0.0.0.0 next to a specific IP). Retrying can't help.
          warn(
            `[bind] ${o.host}:${o.port} is already served by another of this server's --host entries (a duplicate, localhost next to 127.0.0.1, or 0.0.0.0/:: next to a specific address). Remove it from --host; not retrying.`,
          );
          return;
        }
        const t = now();
        if (t - lastInUseWarn >= IN_USE_REPEAT_MS) {
          lastInUseWarn = t;
          inUse = true;
          lookup();
          warn(
            `[bind] ⚠ SECURITY: another process${owner ? ` (pid ${owner})` : ""} is serving ${o.host}:${o.port}, so devices that open that address may reach IT, not autonomOS, and could be shown a fake sign-in page. Stop it; autonomOS keeps retrying every ${Math.round(interval / 1000)}s.`,
          );
        }
      } else if (!waitingLogged) {
        waitingLogged = true;
        log(
          `[bind] ${o.host} isn't available yet (${err.code}; is Tailscale still starting?). Retrying every ${Math.round(interval / 1000)}s; this machine (localhost) is already served.`,
        );
      }
      timer = setTimer(attempt, interval);
    };
    const onListening = () => {
      o.server.removeListener("error", onError);
      if (inUse)
        warn(
          `[bind] ${o.host}:${o.port} is free again: autonomOS is now listening there.`,
        );
      log(`[bind] also listening on http://${o.host}:${o.port}`);
      // A NAME can resolve through /etc/hosts before MagicDNS: a short name is
      // usually the machine's hostname, which Debian/Ubuntu map to 127.0.1.1
      // and cloud VMs to their VPC address (nox, #480). Then the tailnet can't
      // reach this listener. Say so, once, naming the address it really got.
      if (isIP(o.host) === 0) {
        const bound = (o.server.address?.() as { address?: string } | null)
          ?.address;
        if (bound && !isTailscaleAddress(bound))
          warn(
            `[bind] ${o.host} resolved to ${bound}, which isn't a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48); /etc/hosts may map it before MagicDNS. Devices on your tailnet can't reach autonomOS there. Use the tailnet IP ($(tailscale ip -4)) or the full MagicDNS name (<name>.<tailnet>.ts.net).`,
          );
      }
    };
    o.server.once("error", onError);
    o.server.once("listening", onListening);
    o.server.listen(o.port, o.host);
  };
  attempt();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      o.server.close();
    },
  };
}

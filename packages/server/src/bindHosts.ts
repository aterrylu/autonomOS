/**
 * Several bind addresses for the public listener (ADR-136, extends ADR-054).
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
}

export function keepListening(o: {
  server: Listenable;
  host: string;
  port: number;
  intervalMs?: number;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): { stop: () => void } {
  const log = o.log ?? console.log;
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer =
    o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const interval = o.intervalMs ?? 5_000;
  let waitingLogged = false;
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
      if (!waitingLogged) {
        waitingLogged = true;
        log(
          `[bind] ${o.host} isn't available yet (${err.code}; is Tailscale still starting?). Retrying every ${Math.round(interval / 1000)}s; this machine (localhost) is already served.`,
        );
      }
      timer = setTimer(attempt, interval);
    };
    const onListening = () => {
      o.server.removeListener("error", onError);
      log(`[bind] also listening on http://${o.host}:${o.port}`);
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

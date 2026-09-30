import type { Context, MiddlewareHandler } from "hono";

/**
 * CSRF + cross-site WebSocket guard for the PUBLIC listener (V1, ADR-122).
 *
 * The session cookie is `SameSite=Lax`, and "site" ignores the port: a page on
 * ANY other port of the dashboard's host (an agent's dev server, Jupyter, a
 * preview server) or a sibling subdomain is same-site, so the browser attaches
 * the operator's cookie to its POSTs and WebSocket handshakes. SameSite was
 * the only barrier, and it doesn't hold here. This middleware is the one
 * boundary for every state-changing request and every upgrade. It replaces
 * #392's per-route copy on the update routes.
 *
 * Three rules:
 *  1. **Where the request came from.** An `Origin` that exactly matches an
 *     origin the operator set EXPLICITLY in `CORS_ORIGIN` passes (ADR-125).
 *     Otherwise, a browser labels every request: if `Sec-Fetch-Site` is
 *     present it must be `same-origin` or `none` (a typed URL / bookmark).
 *     `same-site` is exactly the attack, so it's refused. An older browser
 *     without Fetch Metadata still sends `Origin` on POSTs and WS handshakes,
 *     and that must name this server (the `Host` it was reached on).
 *  2. **No labels → not a browser.** The CLI, agents' channel server, curl,
 *     Node/Bun fetch and `ws` send neither header (measured), and a browser
 *     can't omit both on a cross-origin request. So they pass rule 1
 *     untouched and still need their token like before.
 *  3. **JSON only.** A form (`text/plain`, urlencoded, multipart) is a
 *     "simple" request with no CORS preflight. A mutating request that
 *     declares a body type must declare JSON, and one without a type must
 *     have no body. A request authenticating with `Authorization: Bearer`
 *     is exempt from this rule only: a browser never attaches that header
 *     on its own, and a page can't add it cross-origin without a preflight
 *     this server doesn't grant. That keeps `curl -d` and similar scripts
 *     working.
 *
 * It runs BEFORE auth, so login (`POST /api/auth`, ADR-117 follow-up 4) and
 * unauthenticated probes are covered too. It keys only on request headers,
 * never on which credential authenticated. The internal Unix socket never
 * mounts it: no browser can open that socket.
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

export interface SameOriginGuardOptions {
  /** Extra origins to trust besides this server's own (e.g. `CORS_ORIGIN`),
   *  exact `scheme://host[:port]` strings. */
  allowedOrigins?: readonly string[];
  /** Where refusals are reported. Defaults to console.warn, capped. */
  warn?: (line: string) => void;
}

/** Why a request was refused, or null when it may proceed. Exported for the
 *  unit tests; the middleware is the only production caller. */
export function sameOriginVerdict(
  c: Context,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  const fetchSite = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  // An origin the operator configured (CORS_ORIGIN) is trusted whatever the
  // browser's label. A modern browser on that separate origin sends
  // `Sec-Fetch-Site: same-site` or `cross-site`, and refusing it would make
  // the setting (and the refusal log's advice to use it) dead (nox, #447).
  // Origin is unforgeable from a page, so this admits only that origin.
  if (origin !== undefined && allowedOrigins.has(origin)) {
    // provenance ok; the body rule below still applies
  } else if (fetchSite !== undefined) {
    // The browser vouched for where this came from. Don't second-guess it
    // with Origin vs Host: a Host-rewriting reverse proxy (stock nginx
    // proxy_pass) would then refuse every legitimate click.
    if (!ALLOWED_FETCH_SITES.has(fetchSite.toLowerCase()))
      return `Sec-Fetch-Site: ${fetchSite}`;
  } else if (origin !== undefined) {
    if (!originIsSelf(c, origin) && !allowedOrigins.has(origin))
      return `Origin: ${origin}`;
  }

  if (MUTATING.has(c.req.method) && !hasBearer(c)) {
    const type = c.req.header("Content-Type");
    if (type !== undefined) {
      if (!isJsonType(type)) return `Content-Type: ${type}`;
    } else if (hasBody(c)) {
      return "a body without a Content-Type";
    }
  }
  return null;
}

/**
 * The CORS origin and the origins the guard TRUSTS, from one place so they
 * can't drift. Dev mode (no dashboard build) defaults CORS to the vite port,
 * but that implicit origin is NOT trusted to skip Fetch Metadata: any other
 * vite dev server on :5173 (an agent's repo) could otherwise make
 * cookie-authenticated writes (SecurityAudit, #453). Only an origin the
 * operator set explicitly in CORS_ORIGIN is trusted. The dev dashboard doesn't
 * need it: vite proxies /api and /ws, so its requests are same-origin.
 */
export function resolveCorsOrigins(o: {
  env: NodeJS.ProcessEnv;
  isProduction: boolean;
}): { cors: string | undefined; trusted: string[] } {
  const explicit = o.env.CORS_ORIGIN || undefined;
  return {
    cors: explicit ?? (o.isProduction ? undefined : "http://localhost:5173"),
    trusted: explicit ? [explicit] : [],
  };
}

/** Hono middleware. Refuses with 403 `CROSS_ORIGIN`. */
export function sameOriginGuard(
  opts: SameOriginGuardOptions = {},
): MiddlewareHandler {
  const allowed = new Set(opts.allowedOrigins ?? []);
  const warn = opts.warn ?? cappedWarn();
  return async (c, next) => {
    // Reads are left alone, except WebSocket handshakes: those are GETs, and a
    // hijacked socket reads the fleet and types into terminals.
    const isUpgrade = c.req.header("Upgrade")?.toLowerCase() === "websocket";
    if (!MUTATING.has(c.req.method) && !isUpgrade) return next();
    const reason = sameOriginVerdict(c, allowed);
    if (reason === null) return next();
    warn(
      `[auth] refused a cross-origin ${isUpgrade ? "WebSocket upgrade" : c.req.method} on ${c.req.path} (${reason}). The dashboard is same-origin, so this came from another page or port. If you serve the dashboard from a different origin on purpose, set CORS_ORIGIN.`,
    );
    return c.json(
      {
        error:
          "Refused: this request came from another site or port. Use the dashboard itself.",
        code: "CROSS_ORIGIN",
      },
      403,
    );
  };
}

function originIsSelf(c: Context, origin: string): boolean {
  let host: string;
  try {
    // `Origin: null` (sandboxed frame, file://) doesn't parse, so it's refused.
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = [c.req.header("Host"), c.req.header("X-Forwarded-Host")];
  return own.some((h) => h !== undefined && h.toLowerCase() === host);
}

function isJsonType(type: string): boolean {
  const essence = type.split(";")[0].trim().toLowerCase();
  return (
    essence === "application/json" ||
    /^application\/[\w.+-]+\+json$/.test(essence)
  );
}

function hasBody(c: Context): boolean {
  if (c.req.header("Transfer-Encoding") !== undefined) return true;
  const len = c.req.header("Content-Length");
  return len !== undefined && len.trim() !== "0";
}

function hasBearer(c: Context): boolean {
  return c.req.header("Authorization")?.startsWith("Bearer ") ?? false;
}

/** One line per refusal for the first 20, then a running count at each
 *  power of ten (100, 1000, …). A hostile page retrying in a loop can't fill
 *  the log, and an ongoing attack still shows up in it. */
export function cappedWarn(
  limit = 20,
  sink: (line: string) => void = console.warn,
): (line: string) => void {
  let n = 0;
  let nextTally = 100;
  return (line) => {
    n += 1;
    if (n <= limit) sink(line);
    if (n === limit)
      sink(
        "[auth] further cross-origin refusals are counted, not logged one by one",
      );
    if (n === nextTally) {
      sink(
        `[auth] ${n} cross-origin requests refused since start (${n - limit} not logged individually); latest: ${line}`,
      );
      nextTally *= 10;
    }
  };
}

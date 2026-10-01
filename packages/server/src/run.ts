// `runServer(argv)` — the autonomos-server startup logic, exposed as a callable
// function so the CLI (`autonomos start`) and the standalone entry point
// (`packages/server/src/index.ts`) can both invoke it without duplicating
// logic.
//
// Behavior identical to the pre-Phase-1C top-level startup. The single
// addition: it writes a PID file at $configDir/autonomos.pid for the CLI's
// stop/status/upgrade commands to consume.

import { timingSafeEqual } from "node:crypto";
import { existsSync, writeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { HostInfo } from "@autonomos/core";
import { createAdaptorServer, serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import {
  sweepAgentTokenFiles,
  sweepStaleStatuslineCaches,
} from "./agentCredentials.js";
import { migrateIfNeeded } from "./agents/migrate.js";
import { awaitPtyExits } from "./agents/ptyTerminate.js";
import {
  resumeActiveAgents,
  shutdownAllAttachments,
  snapshotResumableAgents,
} from "./agents/runtime.js";
import { SIDECAR_EXIT_CAP_MS, stopAllSidecars } from "./agents/sidecar.js";
import { reapAllOrphanSidecars } from "./agents/sidecarRecords.js";
import {
  describeTokenForLog,
  isPriorInstall,
  isWeakToken,
  resolveAuthTokenWithSource,
  type TokenSource,
  weakTokenPolicy,
} from "./auth.js";
import {
  authCookieName,
  LEGACY_AUTH_COOKIE,
  signInLink,
} from "./authCookie.js";
import {
  AuthFailureLimiter,
  cappedLockoutWarn,
  peerAddress,
  rawPeerAddress,
} from "./authRateLimit.js";
import { parseCliArgs, printUsage } from "./cli-args.js";
import { getConfigDir, tightenConfigDirModes } from "./configDir.js";
import { readDashboardBuild } from "./dashboardBuild.js";
import { mountDashboard } from "./dashboardStatic.js";
import { installErrorHandling } from "./httpError.js";
import {
  assertUsableSocketPath,
  getControlSocketPath,
  prepareControlSocket,
  removeControlSocket,
  restrictControlSocket,
} from "./internalSocket.js";
import { initFileLogging, writeUnlogged } from "./logger.js";
import { handleMcpRequest, handleMcpSessionRequest } from "./mcp.js";
import {
  NewDeviceLock,
  newDeviceFailureLimit,
  newDeviceLockPath,
} from "./newDeviceLock.js";
import { acquireOwnership, removePidFile } from "./pid-file.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
import { codexUsageRouter } from "./plugins/codex-usage/route.js";
import { installUnhandledRejectionLogger } from "./processSafetyNet.js";
import { writeGeminiSettings } from "./providers/gemini-cli.js";
import { getAllProviders, isProviderInstalled } from "./providers/index.js";
import { initPtyInputLog } from "./ptyInputLog.js";
import { createAgentApi, gatewayUpgradeAuth } from "./routes/agentApi.js";
import { agentsRouter } from "./routes/agents.js";
import { channelsRouter } from "./routes/channels.js";
import { envPresetRouter } from "./routes/env-presets.js";
import { gatewayRouter, limitGatewayFrames } from "./routes/gateway.js";
import {
  agentStatusRouter,
  hooksIngestRouter,
  notificationsRouter,
} from "./routes/hooks.js";
import { projectRouter } from "./routes/projects.js";
import { providerRouter, warmPermissionChecks } from "./routes/providers.js";
import { scheduleRouter, schedulerRouter } from "./routes/schedules.js";
import { settingsRouter } from "./routes/settings.js";
import { systemRouter } from "./routes/system.js";
import { templateRouter } from "./routes/templates.js";
import { terminalRouter } from "./routes/terminal.js";
import { usageQueueRouter } from "./routes/usageQueue.js";
import { resolveCorsOrigins, sameOriginGuard } from "./sameOriginGuard.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import { CHANNEL_SERVER_SCRIPT, STATUSLINE_SCRIPT } from "./scriptPaths.js";
import {
  getServerPort,
  setAuthToken,
  setInternalSocketPath,
  setServerPort,
} from "./serverState.js";
import { createShutdownHandler } from "./shutdown.js";
import { seedDefaultTemplates } from "./templates.js";
import { getServerVersion } from "./version.js";
import { agentsRouter as agentsWsRouter } from "./ws/agents.js";

type NodeEnv = {
  Bindings: {
    incoming: IncomingMessage;
    outgoing: ServerResponse;
  };
};

/**
 * True when the bind is restricted to a loopback interface — reachable from
 * this machine only, not the network. Exported for tests.
 *
 * `undefined` means "no host set" → Node binds all interfaces (see
 * resolveBindHost), so it is NOT loopback. This drives an informational startup
 * line, not any auth decision: auth is required on every route regardless of
 * bind, and per ADR-041 no route should be auth-exempt "because loopback".
 * ONE deliberate exception (ADR-072): perf-harness mode (`AUTONOMOS_PERF=1`)
 * consults this to REFUSE engaging on a non-loopback bind — loopback as a
 * precondition for weakening auth, never as a substitute for it.
 */
export function isLoopbackBind(bindHost: string | undefined): boolean {
  return (
    bindHost === "localhost" || bindHost === "127.0.0.1" || bindHost === "::1"
  );
}

/**
 * Resolve the interface to bind. Precedence: --host > AUTONOMOS_HOST > unset.
 *
 * Returns `undefined` when nothing is set, and the caller passes that straight
 * to `serve()` — Node then binds all interfaces (`::` dual-stack), which is the
 * server's long-standing behavior. We deliberately do NOT default to a safer
 * loopback bind: this server is commonly deployed to a remote box reached over
 * Tailscale / IAP / SSH, and those need a network interface. The RCE it used to
 * enable is closed by requiring auth on `/mcp`, not by hiding the port.
 *
 * The flag is therefore an opt-in to RESTRICT (`--host=127.0.0.1` for a box you
 * only reach via an SSH tunnel), not to expose. Uses AUTONOMOS_HOST rather than
 * bare HOST, which unrelated tooling sets and would silently move the bind.
 * Exported for tests.
 */
export function resolveBindHost(
  cliHost: string | undefined,
  envHost: string | undefined,
): string | undefined {
  const host = stripSurroundingQuotes((cliHost ?? envHost ?? "").trim());
  return host || undefined;
}

// `tsx --env-file` (the prod wrapper) and hand-quoted service-file args pass
// `AUTONOMOS_HOST="127.0.0.1"` through WITH the quote characters, and a hostname
// carrying quotes fails `serve()` with ENOTFOUND — a crash-loop from a habitual
// `.env` quoting mistake. A hostname/IP never legitimately contains a
// surrounding quote pair, so peeling one matched pair is safe and yields the
// intended bind.
function stripSurroundingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value[value.length - 1] === value[0]
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Run the autonomos-server until it shuts down. Returns a promise that
 * resolves only on clean shutdown (which currently calls process.exit() so
 * this rarely returns in practice — the caller sees process exit before
 * the promise resolves).
 */
export async function runServer(argv: readonly string[]): Promise<void> {
  // Parse CLI flags. --help short-circuits before any startup work.
  const cliArgs = parseCliArgs(argv);
  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }

  // Is this install new? Read BEFORE this boot writes anything. The markers
  // (agents/, templates/, settings.json) are written only past the token
  // check below, so a boot refused for a weak token leaves none behind and
  // an identical re-run is refused again (V2b, ADR-130).
  const priorInstall = isPriorInstall(getConfigDir());

  // Owner-only modes on what older builds created loose (V8), BEFORE the log
  // file is opened. Only removes group/other bits: never breaks auth.
  const tightened = tightenConfigDirModes();
  // Tee stdout/stderr into a rotating $configDir/logs/autonomos.log as early as
  // possible, so everything below is captured under OS-native supervision (the
  // supervisor's own stdout goes to /dev/null — see service-templates.ts). Best
  // effort: a logging failure never blocks startup.
  initFileLogging();
  if (tightened.length > 0) {
    console.warn(
      `[security] removed group/other access from ${tightened.length} path(s) under the config dir that an older version created readable by other users: ${tightened.join(", ")}`,
    );
  }
  // Opt-in keystroke forensics: off unless AUTONOMOS_PTY_INPUT_LOG=1 or the
  // one-shot $configDir/pty-input-log.on exists. After file logging so its
  // loud ON line lands in autonomos.log too.
  initPtyInputLog({ configDir: getConfigDir() });

  // The operator token, and whether it's strong enough to start with. Decided
  // here: after logging (so a refusal lands in the log a supervised install
  // has) and before anything writes an install marker (templates just below).
  const { token: AUTH_TOKEN, source: tokenSource } =
    resolveAuthTokenWithSource();
  enforceTokenStrength({
    token: AUTH_TOKEN,
    source: tokenSource,
    priorInstall,
    networkBind: !isLoopbackBind(
      resolveBindHost(cliArgs.host, process.env.AUTONOMOS_HOST),
    ),
    allowWeak:
      cliArgs.allowWeakToken || process.env.AUTONOMOS_ALLOW_WEAK_TOKEN === "1",
  });

  // Seed default templates on fresh install
  seedDefaultTemplates();

  // Validate provider binaries at startup.
  // Claude Code is required (default provider) — others are optional.
  for (const p of getAllProviders()) {
    try {
      const path = p.resolveBinary();
      console.log(`${p.displayName} found: ${path}`);
    } catch (err) {
      if (p.name === "claude-code") {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("not found")) {
        console.warn(`[providers] ${p.displayName} check failed: ${msg}`);
      }
    }
  }

  // Runtime-loaded scripts are staged into the bundle by build-binary.ts.
  // If one is missing (bad staging, hand-rolled install), the downstream
  // failures are SILENT — CC swallows statusline command errors, and the
  // per-agent MCP channel-server subprocess just never starts. Surface it
  // once at boot so the outage is visible in server logs.
  for (const script of [STATUSLINE_SCRIPT, CHANNEL_SERVER_SCRIPT]) {
    if (!existsSync(script)) {
      console.warn(
        `[startup] runtime script missing: ${script} — ` +
          `spawned agents will silently lack the statusline / MCP channel server`,
      );
    }
  }

  // NOTE: Gemini settings are written later, inside armRuntimeInits, once the
  // port and control socket are both bound (ADR-055 PR B). Writing them here —
  // before either exists — is what baked a wrong URL into every Gemini agent.

  // Run sessions.json → per-file agents migration if needed.
  // MUST happen before resumeActiveAgents() reads from the new layout.
  // Process-manager-agnostic: works under pm2, npx, bun, or manual node.
  //
  // We exit non-zero on failure so pm2/systemd flag the unhealthy boot
  // rather than letting the server come up with a half-migrated state
  // where /api/agents would silently be missing records.
  try {
    const migrationResult = migrateIfNeeded();
    if (migrationResult.status === "migrated") {
      console.log(
        `[startup] migrated ${migrationResult.agents} agent(s) from sessions.json (` +
          `${migrationResult.managersResolved} managers resolved, ` +
          `${migrationResult.orphaned} orphaned)`,
      );
    }
  } catch (err) {
    console.error(
      "MIGRATION FAILED — investigate ~/.autonomos/sessions.json and ~/.autonomos/agents/ before restarting.",
    );
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(2);
  }

  const app = new Hono<NodeEnv>();
  // One error envelope for the whole surface (ADR-078). Installed before the
  // routes so nothing can be mounted "outside" it: onError/notFound are
  // app-level, and a router with its own onError still composes on top
  // (agents.ts) because Hono runs the nearest handler.
  installErrorHandling(app, "api");

  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // The internal control plane (ADR-055). A SEPARATE Hono app served over a
  // Unix domain socket rather than the public TCP listener, so the routes that
  // exist for autonomOS's own processes — `/mcp`, `/api/hooks`, and (PR B)
  // `/ws/gateway` — are simply not reachable from the network. Not "reachable
  // but rejected": there is no port to connect to. The public listener below
  // keeps only the browser surface.
  const internalApp = new Hono<NodeEnv>();
  // Same envelope on the control socket — a failure's shape must not depend on
  // which listener the request arrived through.
  installErrorHandling(internalApp, "internal");

  // Per-app WebSocket closures for the internal listener. createNodeWebSocket
  // returns per-app upgrade/inject functions — calling it a second time for
  // internalApp does NOT conflict with the public app's pair above (no shared
  // singleton). iInject is wired to internalServer once it exists (below).
  const {
    upgradeWebSocket: iUpgrade,
    injectWebSocket: iInject,
    wss: internalWss,
  } = createNodeWebSocket({ app: internalApp });
  // The internal app's only WebSocket is /ws/gateway: cap its frame size.
  limitGatewayFrames(internalWss);

  // Serve dashboard static files in production.
  //
  // Path resolution order:
  //   1. ./src/_embedded_dashboard/    — populated at binary build time
  //                                      (see build/embed-dashboard.ts).
  //   2. ../../dashboard/dist          — local dev fallback when running via
  //                                      tsx without the embed step.
  //
  // We check for index.html specifically (not just dir existence) because
  // tooling like `tsc -b` may create the dist directory with .d.ts files
  // without producing a Vite bundle.
  const dashboardCandidates = [
    resolve(import.meta.dirname, "_embedded_dashboard"),
    resolve(import.meta.dirname, "../../dashboard/dist"),
  ];
  const dashboardDist =
    dashboardCandidates.find((d) => existsSync(resolve(d, "index.html"))) ??
    null;
  const isProduction = dashboardDist !== null;
  // Build identity of the dashboard we're about to serve — surfaced in the
  // startup log and /api/host so a stale-serve (e.g. a leftover embedded bundle
  // shadowing a freshly built dist) is immediately visible instead of silent.
  const dashboardBuild = dashboardDist
    ? readDashboardBuild(dashboardDist)
    : null;
  // /api/host reports the build a reload would get NOW. mountDashboard (below)
  // swaps in its live getter: it re-reads index.html when it changes, so a
  // boot-time value would make the tab's staleness check warn about a rebuild
  // it has already loaded.
  let currentDashboardBuild = () => dashboardBuild;

  const { cors: corsOrigin, trusted: csrfTrustedOrigins } = resolveCorsOrigins({
    env: process.env,
    isProduction,
  });
  if (corsOrigin) {
    app.use("*", cors({ origin: corsOrigin }));
  }

  // CSRF + cross-site WebSocket guard (V1, sameOriginGuard.ts). Registered
  // before EVERY /api and /ws handler, including the login route below: Hono
  // runs handlers in registration order, so a route added above this line
  // would skip it.
  const csrf = sameOriginGuard({
    allowedOrigins: csrfTrustedOrigins,
  });
  app.use("/api/*", csrf);
  app.use("/ws/*", csrf);

  // Publish to serverState so spawn-time code (runtime.ts, providers/*) can read
  // the in-process token without round-tripping through env or disk.
  setAuthToken(AUTH_TOKEN);

  function safeEqual(a: string, b: string): boolean {
    // Compare BYTE lengths: a same-length multibyte string (a junk cookie any
    // other localhost page can plant) makes timingSafeEqual throw → a 500.
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /** This listener's session cookie name (per port, see authCookie.ts). */
  function currentCookieName(): string {
    try {
      return authCookieName(getServerPort());
    } catch {
      return LEGACY_AUTH_COOKIE; // before listen() — never a live request
    }
  }

  /** Every credential the request carries, in precedence order. ALL are
   *  tried (the first VALID wins, not the first present): the legacy cookie is
   *  sent to every localhost port, so a stale one must not shadow a good
   *  per-port cookie or Bearer header. */
  function tokenCandidates(
    c: Context,
  ): Array<{ token: string; source: "cookie" | "legacy-cookie" | "bearer" }> {
    const out: Array<{
      token: string;
      source: "cookie" | "legacy-cookie" | "bearer";
    }> = [];
    const perPort = getCookie(c, currentCookieName());
    if (perPort) out.push({ token: perPort, source: "cookie" });
    const legacy = getCookie(c, LEGACY_AUTH_COOKIE);
    if (legacy && currentCookieName() !== LEGACY_AUTH_COOKIE)
      out.push({ token: legacy, source: "legacy-cookie" });
    const header = c.req.header("Authorization");
    if (header?.startsWith("Bearer "))
      out.push({ token: header.slice(7), source: "bearer" });
    return out;
  }

  /** Set this listener's session cookie (login, and the legacy migration). */
  function setSessionCookie(c: Context, token: string): void {
    const isHttps =
      c.req.url.startsWith("https://") ||
      c.req.header("x-forwarded-proto") === "https";
    setCookie(c, currentCookieName(), token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps,
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  // Failed-auth throttle for the public listener (V2, authRateLimit.ts). The
  // internal socket is same-user only and is never throttled.
  const authLimiter = new AuthFailureLimiter();
  const warnLockout = cappedLockoutWarn();
  // A weak token also gets a CAP on failures from never-seen devices
  // (newDeviceLock.ts, ADR-135): its total exposure is then limit/keyspace.
  const newDeviceLock = new NewDeviceLock({
    enabled: isWeakToken(AUTH_TOKEN),
    path: newDeviceLockPath(getConfigDir()),
    limit: newDeviceFailureLimit(
      process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT,
    ),
  });
  if (newDeviceLock.status().locked)
    console.warn(
      "[auth] New devices are locked out after repeated failed sign-ins (devices already signed in, and this machine, still work). Unlock with `autonomos auth unlock`.",
    );

  /** 423/429 before any credential is evaluated, or null to go on. */
  function throttled(c: Context, address: string): Response | null {
    if (newDeviceLock.refuses(rawPeerAddress(c)))
      return c.json(
        {
          error:
            "New devices are locked after repeated failed sign-ins. Sign in from a device that's already signed in, or run `autonomos auth unlock` on the server.",
          code: "NEW_DEVICES_LOCKED",
        },
        423,
      );
    const v = authLimiter.check(address);
    if (v.ok) return null;
    const secs = Math.ceil(v.retryAfterMs / 1000);
    c.header("Retry-After", String(secs));
    return c.json(
      {
        error: `Too many failed sign-in attempts. Try again in ${secs}s.`,
        code: "RATE_LIMITED",
        retryAfterSec: secs,
      },
      429,
    );
  }

  /** `address` keys the throttle (IPv6 /64); `device` is the exact peer, for
   *  the new-device lock's known check. */
  function recordFailures(
    address: string,
    device: string,
    presented: readonly string[],
  ): void {
    for (const value of presented) {
      const { distinct, lockMs } = authLimiter.recordFailureDetailed(
        address,
        value,
      );
      if (lockMs > 0) warnLockout(address, lockMs);
      if (distinct) newDeviceLock.noteDistinctFailure(device);
    }
  }

  const authHandler = async (c: Context) => {
    const address = peerAddress(c);
    const refused = throttled(c, address);
    if (refused) return refused;
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token : null;
    if (!token || !safeEqual(token, AUTH_TOKEN)) {
      if (token) recordFailures(address, rawPeerAddress(c), [token]);
      return c.json({ error: "Invalid token" }, 401);
    }
    authLimiter.recordSuccess(address);
    newDeviceLock.noteSuccess(rawPeerAddress(c));
    setSessionCookie(c, token);
    return c.json({ ok: true });
  };
  // PR C: /api/auth is the real path (the ONE endpoint that used to live
  // outside /api). It needs an explicit requireAuth exemption below — you
  // cannot hold a token cookie before authenticating. The old /auth alias
  // was removed after its one-release window (ADR-084).
  app.post("/api/auth", authHandler);

  // `?token=` on the PUBLIC listener is deprecated (ADR-117): the
  // dashboard never sends it, and a query string lands in proxy/tunnel logs
  // and browser history. One release of a once-per-process warning — never the
  // value — then removal. The internal socket's /ws/gateway keeps accepting it
  // (the channel server can't set WebSocket upgrade headers).
  let warnedPublicQueryToken = false;
  function warnPublicQueryTokenOnce(path: string): void {
    if (warnedPublicQueryToken) return;
    warnedPublicQueryToken = true;
    console.warn(
      `[auth] a request on ${path.split("/").slice(0, 3).join("/")} authenticated with ?token= on the public listener — deprecated, removed next release. Use the session cookie or "Authorization: Bearer" (the token is not logged).`,
    );
  }
  /**
   * THE credential check: which credential (if any) authenticates this
   * request, and every value it presented (for the failure throttle). A
   * second credential kind (e.g. the per-agent token, V3) is added HERE, so
   * the throttle covers it without further wiring.
   */
  function verifyCredential(
    c: Context,
    queryToken: "allowed" | "deprecated",
  ): {
    match: {
      kind: "operator";
      source: "cookie" | "legacy-cookie" | "bearer" | "query";
      token: string;
    } | null;
    presented: string[];
  } {
    const candidates = tokenCandidates(c);
    const presented = candidates.map((k) => k.token);
    const hit = candidates.find((k) => safeEqual(k.token, AUTH_TOKEN));
    if (hit) return { match: { kind: "operator", ...hit }, presented };
    if (candidates.length === 0) {
      const fromQuery = c.req.query("token");
      if (fromQuery && queryToken === "deprecated")
        warnPublicQueryTokenOnce(c.req.path);
      if (fromQuery) {
        presented.push(fromQuery);
        if (safeEqual(fromQuery, AUTH_TOKEN))
          return {
            match: { kind: "operator", source: "query", token: fromQuery },
            presented,
          };
      }
    }
    return { match: null, presented };
  }

  const makeRequireAuth =
    (
      queryToken: "allowed" | "deprecated",
      throttle: boolean,
    ): MiddlewareHandler =>
    async (c, next) => {
      // NOTE: the `POST /api/hooks/*` exemption is GONE (ADR-055). Hook ingestion
      // moved to the internal socket, so nothing on the public listener needs to
      // accept an unauthenticated write any more. The exemption was also wider
      // than its purpose — it covered the dashboard's `POST /api/hooks/:id/read`
      // too. Removing it means there is no unauthenticated POST anywhere on the
      // public surface; the browser already sends the token for /read.
      if (c.req.method === "GET" && c.req.path === "/api/host") return next();
      // Agent SELF metadata (statusline, #297 follow-up): the PTY env carries
      // no server token by design, so this one narrow GET is authenticated by
      // the PER-AGENT token INSIDE the route (verifyAgentToken 401s there —
      // deny-by-default is preserved, just enforced at the route).
      if (
        c.req.method === "GET" &&
        /^\/api\/agents\/[A-Za-z0-9-]+\/self$/.test(c.req.path)
      )
        return next();
      // The login endpoint itself — a browser cannot present the cookie it is
      // asking for. Token verification happens inside the handler.
      if (c.req.method === "POST" && c.req.path === "/api/auth") return next();
      const address = throttle ? peerAddress(c) : "";
      if (throttle) {
        const refused = throttled(c, address);
        if (refused) return refused;
      }
      const { match, presented } = verifyCredential(c, queryToken);
      if (match) {
        // No recordSuccess here: on a shared address (reverse proxy, NAT) the
        // operator's ordinary traffic would reset an attacker's backoff on
        // every request (SecurityAudit, #452). Only an explicit sign-in
        // (POST /api/auth) clears the record; otherwise it decays IDLE_MS after
        // its last failure.
        // Signed in on the legacy shared cookie: move this browser onto the
        // per-port one, so an older instance on the same host rewriting the
        // shared cookie can no longer log it out here.
        if (match.source === "legacy-cookie") setSessionCookie(c, match.token);
        // A device a valid credential came from is never locked out.
        if (throttle) newDeviceLock.noteSuccess(rawPeerAddress(c));
        return next();
      }
      // A request that presented nothing (the dashboard probing before sign-in)
      // made no guess and isn't counted.
      if (throttle) recordFailures(address, rawPeerAddress(c), presented);
      return c.json(
        {
          error:
            "Unauthorized — open the dashboard and paste your token at the login screen",
        },
        401,
      );
    };
  /** Internal socket (/mcp, /ws/gateway): ?token= stays accepted. */
  const requireAuth = makeRequireAuth("allowed", false);
  /** Public listener: ?token= still works this release, with a warning. */
  const requireAuthPublic = makeRequireAuth("deprecated", true);

  // DEV/PERF ONLY — perf harness mode (set by perf/run-l2.sh). Mounts
  // /api/perf AND drops auth on the PUBLIC listener so Playwright needn't
  // thread tokens through the vite proxy. One flag, decided once at boot, and
  // it engages ONLY on a loopback bind: an all-interfaces server ignores it
  // (an unauthenticated POST /api/agents is LAN-reachable code execution, not
  // a benchmark convenience). The internal socket (/mcp, gateway) keeps its
  // token check either way — the bypass below is publicAuth, never requireAuth.
  const perfMode =
    process.env.AUTONOMOS_PERF === "1" &&
    isLoopbackBind(resolveBindHost(cliArgs.host, process.env.AUTONOMOS_HOST));
  if (process.env.AUTONOMOS_PERF === "1" && !perfMode) {
    console.warn(
      "[perf] AUTONOMOS_PERF=1 ignored — bind host is not loopback; auth stays ON and /api/perf is not mounted",
    );
  }
  if (perfMode) {
    console.warn(
      "[perf] PERF HARNESS MODE — public-listener auth DISABLED (loopback bind, /api/perf mounted)",
    );
  }
  const publicAuth: MiddlewareHandler = perfMode
    ? (_c, next) => next()
    : requireAuthPublic;

  app.use("/api/*", publicAuth);
  app.use("/ws/*", publicAuth);
  // /mcp exposes the same orchestration tools as the dashboard API —
  // create_agent, kill_agent, set_manager. It is NOT a public transport.
  //
  // It now lives on the internal socket (ADR-055), so the token is no longer
  // the only thing standing between the network and agent spawning — reaching
  // it at all requires being a process on this box running as this user. The
  // auth check stays as defense in depth: the socket answers the "who can
  // connect" question, the token still answers "prove it".
  internalApp.use("/mcp", requireAuth);

  // The new-device lock (ADR-135): its state for the dashboard and CLI, and
  // the operator's unlock. Both behind auth, so only a device holding the
  // token (which the lock never refuses) can read or clear it.
  app.get("/api/auth/lock", (c) => c.json(newDeviceLock.status()));
  app.post("/api/auth/unlock", (c) => {
    newDeviceLock.unlock();
    console.log("[auth] new-device lock cleared by the operator");
    return c.json(newDeviceLock.status());
  });

  app.get("/api/host", (c) =>
    c.json({
      hostname: hostname(),
      dashboard: currentDashboardBuild(),
    } satisfies HostInfo),
  );

  // Hook INGEST is internal-only (unchanged — the relay curls post here).
  // The READ surface renamed in PR C to say what it serves: the status map
  // at /api/agent-status, the feed + read-marking at /api/notifications.

  internalApp.route("/api/hooks", hooksIngestRouter);
  // The channel server's MCP tools, on the per-AGENT credential (audit V3).
  // Internal socket only: the public listener's auth stays operator-only.
  internalApp.route("/api", createAgentApi());
  app.route("/api/agent-status", agentStatusRouter);
  app.route("/api/notifications", notificationsRouter);

  // REST API (behind auth)
  app.route("/api/projects", projectRouter);
  app.route("/api/agents", agentsRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/channels", channelsRouter);
  app.route("/api/templates", templateRouter);
  app.route("/api/env-presets", envPresetRouter);
  app.route("/api/providers", providerRouter);
  // PR C: scheduler control lives under /api/schedules/{status,settings}.
  // Mount ORDER is load-bearing: the static routes must register before the
  // :name router or the param route shadows them (verified — Hono resolves
  // same-base mounts in registration order). "status"/"settings" are also
  // reserved as schedule names at create (validation.ts) so a schedule can
  // never claim those keys.
  app.route("/api/schedules", schedulerRouter);
  app.route("/api/schedules", scheduleRouter);
  app.route("/api/plugins/claude-usage", claudeUsageRouter);
  app.route("/api/plugins/codex-usage", codexUsageRouter);
  app.route("/api/usage-queue", usageQueueRouter);
  app.route("/api/system", systemRouter);

  // DEV/PERF ONLY — synthetic session register + burst trigger for the L2
  // browser benchmark. Dynamic import so the perf modules (FakePty, ink-burst)
  // stay out of the production server's eager import graph.
  if (perfMode) {
    const { perfRouter } = await import("./routes/perf.js");
    app.route("/api/perf", perfRouter);
  }

  // MCP — Streamable HTTP transport, served on the internal socket only.
  internalApp.post("/mcp", async (c) => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    const body = await c.req.json().catch(() => undefined);
    await handleMcpRequest(req, res, body);
    return new Response(null);
  });
  internalApp.get("/mcp", async (c) => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    await handleMcpSessionRequest(req, res);
    return new Response(null);
  });
  internalApp.delete("/mcp", async (c) => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    await handleMcpSessionRequest(req, res);
    return new Response(null);
  });

  // WebSocket — terminal PTY streaming, gateway, agent deltas
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
  app.get("/ws/agents", agentsWsRouter(upgradeWebSocket));

  // /ws/gateway is the inter-agent messaging transport (ADR-055 PR B): it lives
  // on the internal socket, NOT the public listener. The token check stays as
  // defense in depth — same posture as /mcp: the socket answers "who may
  // connect" (same-user on-box), the token still answers "prove it". Per-agent
  // identity (a later layer) will replace the client-asserted register name.
  // Upgrade auth: the channel server presents its per-AGENT credential (audit
  // V3); the operator token stays accepted for a channel server from before
  // that change (upgrade window). The register frame still verifies identity.
  internalApp.use("/ws/gateway", gatewayUpgradeAuth(requireAuth));
  internalApp.get("/ws/gateway", gatewayRouter(iUpgrade));

  if (isProduction && dashboardDist !== null) {
    console.log(
      `Serving dashboard from ${dashboardDist} ` +
        `(build ${dashboardBuild?.build ?? "?"}, built ${dashboardBuild?.builtAt ?? "?"})`,
    );

    // Same envelope as the app-level notFound (which never fires in prod —
    // the SPA catch-all below is a ROUTE and answers everything else).
    const apiNotFound = (c: Context) =>
      c.json(
        { error: `Not found: ${c.req.path}`, code: "NOT_FOUND" as const },
        404,
      );
    app.all("/api/*", apiNotFound);
    app.all("/ws/*", apiNotFound);
    // /mcp is internal-socket-only (ADR-055) and has no public handler. This
    // must stay: without it the SPA catch-all below would answer a public
    // /mcp probe with index.html, which reads like "the endpoint is here" to
    // anyone scanning. 404 is the honest answer.
    app.all("/mcp", apiNotFound);

    // Static assets + SPA fallback, with explicit caching and precompressed
    // variants (see dashboardStatic.ts).
    currentDashboardBuild = mountDashboard(app, dashboardDist).currentBuild;
  }

  // The internal listener. `serve()` is port-only, so we build the adaptor
  // server directly — it is a plain node http.Server, which listen()s on a
  // socket path just as happily as on a port.
  const internalServer = createAdaptorServer({ fetch: internalApp.fetch });
  // Attach the internal app's WebSocket upgrade handler (for /ws/gateway) to the
  // internal server. Wired before listen() so no upgrade can race an unhandled
  // socket — the exact gap flagged in the PR A boot-ordering review.
  iInject(internalServer);
  const controlSocketPath = getControlSocketPath();

  /**
   * Bind the internal control plane.
   *
   * Called from inside the pid-file "we own this config dir" branch, and
   * awaited BEFORE resumeActiveAgents() — resumed agents dial this socket for
   * their hook relay, so it must be accepting connections before the first PTY
   * spawns, not merely "starting".
   */
  async function startInternalControlPlane(): Promise<void> {
    assertUsableSocketPath(controlSocketPath);
    await prepareControlSocket(controlSocketPath);

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error): void => rejectListen(err);
      internalServer.once("error", onError);
      internalServer.listen(controlSocketPath, () => {
        internalServer.off("error", onError);
        restrictControlSocket(controlSocketPath);
        setInternalSocketPath(controlSocketPath);
        // NOTE: deliberately NOT shaped like "listening on <url>" —
        // helpers/test-server.ts parses that phrase to discover the public
        // port, and a second matching line would hand tests a socket path
        // where they expect a URL.
        console.log(`[internal] control socket ready at ${controlSocketPath}`);
        resolveListen();
      });
    });
  }

  /**
   * Arm every init that mutates ~/.autonomos state or spawns processes.
   *
   * Ordering is load-bearing: the control socket must accept connections
   * before any agent PTY exists, or a resumed agent's hook curls fail against
   * a socket that isn't there yet — and hook failures are SILENT by design
   * (`curl -sf ... >/dev/null 2>&1`), so the symptom would be a dashboard that
   * has simply gone blind on telemetry, with nothing in the logs.
   */
  async function armRuntimeInits(): Promise<void> {
    try {
      await startInternalControlPlane();
    } catch (err) {
      // Fatal by choice. Without the control plane, agents spawn but their
      // hooks vanish silently and /mcp is unreachable — a server that looks
      // healthy and isn't. Better to fail the boot loudly so the supervisor
      // (launchd/systemd-user) surfaces it.
      console.error(
        "[internal] FAILED to bind the control socket — refusing to start " +
          "without a control plane (agent hooks and /mcp would silently break):",
      );
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(3);
    }

    // Clear stale per-agent token files a crash left behind (no markExited
    // revoke), before any respawn re-writes them — the resume below re-mints +
    // re-writes for every agent that actually comes back, so sweeping first
    // makes the on-disk set match reality (ADR-055 follow-up). Best-effort.
    //
    // Placement is load-bearing, TWO constraints:
    //   1. AFTER startInternalControlPlane() succeeds, never earlier. The socket
    //      bind doubles as the cross-process mutual-exclusion guard — a second
    //      server that loses the race process.exit(3)s *inside* that call. Sweep
    //      before it and a doomed second server would wipe the LIVE server's
    //      whole token dir on its way out, killing every live agent's outbound.
    //   2. BEFORE the first `await` below (the gateway import). assertSpawnReady
    //      passes the moment BOTH the port and this socket are set, so `POST
    //      /api/agents` → spawnAgent → writeAgentTokenFile(agent.id) is live from
    //      the bind onward. Any `await` here yields the loop to such a handler; a
    //      token file written in that window would be swept out from under a fresh
    //      agent, which (with the env fallback now gone) leaves it silently
    //      outbound-dead. There is no `await` between the bind and this line, so
    //      the window is closed — the loop cannot run a handler between them.
    sweepAgentTokenFiles();
    sweepStaleStatuslineCaches();

    // Snapshot the agents to resume HERE, synchronously, for the same reason
    // the token sweep sits here: POST /api/agents is live from the bind, and
    // every `await` below yields to it. A spawn that lands in that window is a
    // fresh LIVE agent of this boot, not a record from before the restart — a
    // sweep that re-listed the store after the awaits picked it up, failed to
    // "resume" it (already attached), and marked it crashed with its token
    // revoked (the agent-spawn-prompt CI flake; #382's new import widened the
    // window). Taking the list before the first await closes it for good, no
    // matter what gets awaited below later.
    const toResume = snapshotResumableAgents();

    // Initialize gateway (platform adapters, routing table).
    const { initGateway } = await import("./gateway/index.js");
    initGateway().catch((err) => console.error("[gateway] init failed:", err));

    // Keep every agent row's "project · branch" current for all providers
    // (branch read from .git, not Claude Code's JSONL).
    const { startGitBranchRefresher } = await import(
      "./agents/gitBranchRefresher.js"
    );
    startGitBranchRefresher();

    // Background update-availability check (ADR-077 §6): first run minutes
    // after boot, then ~daily; unref'd timer, settings-gated, never touches
    // a request path. The dashboard badge reads its cache off
    // /api/system/version.
    const { startUpdateCheck } = await import("./updateCheck.js");
    startUpdateCheck();

    // After an in-app/CLI update: compare agents against the pre-update
    // snapshot and record the verdict for the success banner (ADR-105).
    // No-op on an ordinary boot.
    const { startPostUpgradeVerification } = await import("./upgradeVerify.js");
    startPostUpgradeVerification();
    // While an update job is in flight, publish the fleet's busy state for
    // its last-moment "wait for idle" re-check (ADR-105).
    const { startFleetReporter } = await import("./upgradeScheduler.js");
    startFleetReporter();

    // Write the shared Gemini settings file HERE, not at top-of-boot: its MCP
    // config bakes in the control-socket path AND the public REST base, so it
    // can only be correct once both are published (setServerPort in the listen
    // callback + the socket bind just above). Must precede resumeActiveAgents,
    // which may resume a Gemini agent that reads this file. Best-effort — a
    // failure never blocks boot (mirrors the old top-of-boot guard).
    if (isProviderInstalled("gemini-cli")) {
      try {
        writeGeminiSettings(CHANNEL_SERVER_SCRIPT);
      } catch (err) {
        console.warn(
          "[gemini-cli] Failed to write settings — Gemini agents will launch without hooks/MCP:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Auto-resume agents whose persisted status is "running" — handles
    // all failure modes (cwd missing, provider gone, etc) by marking
    // the failed ones exited/crashed so they don't zombie. Spawns
    // PTYs into ~/.autonomos/ — must NOT run if we lost the claim.
    //
    // Now async (provider sidecar daemons start before each PTY). Start
    // the scheduler AFTER agents are up so agent:<name> targets resolve —
    // chain it off the resume promise rather than racing it.
    //
    // First, stop any sidecar daemon a previous server left running (it would
    // keep its agent's thread loaded, so a resumed agent could never receive
    // inbound). Awaited: no daemon may start beside an orphan. It covers agents
    // that won't be resumed too. A failure is logged and never blocks resume.
    void reapAllOrphanSidecars()
      .then((reaped) => {
        const stopped = reaped.filter((r) => r.outcome === "reaped");
        if (stopped.length > 0)
          console.warn(
            `[startup] stopped ${stopped.length} orphaned sidecar daemon(s) from a previous server`,
          );
      })
      .catch((err) =>
        console.error("[startup] orphaned-daemon sweep failed:", err),
      )
      .then(() => resumeActiveAgents(toResume))
      .catch((err) =>
        console.error("[startup] resumeActiveAgents failed:", err),
      )
      .finally(async () => {
        initScheduler();
        // Check each installed CLI's permission options against the
        // runtime table, off the boot path (logs any drift once).
        warmPermissionChecks();
        // The post-update check judges agents only once they've been
        // resumed, not on a fixed timer (ADR-105).
        const { noteAgentsResumed } = await import("./upgradeVerify.js");
        noteAgentsResumed();
      });
  }

  // Port precedence: --port CLI flag > PORT env > 3000 default.
  // --port=0 asks the OS to assign a free port.
  const requestedPort = cliArgs.port ?? (Number(process.env.PORT) || 3000);
  const bindHost = resolveBindHost(cliArgs.host, process.env.AUTONOMOS_HOST);

  const server = serve(
    {
      fetch: app.fetch,
      port: requestedPort,
      hostname: bindHost,
    },
    () => {
      // When --port=0 the OS assigned us a real port; read it from the listener.
      const addr = server.address() as AddressInfo | null;
      const actualPort = addr?.port ?? requestedPort;
      // Publish the OS-assigned port to serverState. Without this, spawned
      // Claude Code sessions (runtime.ts:spawnAgent → providers/*.buildArgs)
      // would still read `process.env.PORT || "3000"` and bake the wrong URL
      // into their hook + MCP-gateway endpoints.
      setServerPort(actualPort);
      const base = `http://localhost:${actualPort}`;
      // NOTE: keep this line's shape — helpers/test-server.ts parses
      // "listening on <url>" to discover the ephemeral port.
      console.log(`autonomOS server listening on ${base}`);
      // Never the value: stdout is teed into the log file (V8).
      console.log(`Auth token: ${describeTokenForLog(AUTH_TOKEN)}`);

      // The default bind is all-interfaces (unchanged, long-standing): this
      // server is commonly reached over Tailscale / IAP / SSH. Surface that
      // posture once, precisely. Post-ADR-055 the only remaining unauthenticated
      // route here is GET /api/host; `/mcp` and hook ingestion are not served on
      // this listener at all. Stay accurate rather than implying blanket
      // coverage. Informational, not an alarm; a loopback bind is silent.
      if (!isLoopbackBind(bindHost)) {
        const iface = bindHost ?? "all interfaces";
        console.log(
          `ℹ Reachable on the network (${iface}). API/WebSocket require the ` +
            `token; only GET /api/host does not (yet). /mcp and hook ingestion ` +
            `are not served here — they are on the internal control socket. ` +
            `Restrict with --host=127.0.0.1 / AUTONOMOS_HOST=127.0.0.1.`,
        );
      }

      // --print-url: a sign-in link (token in the #fragment) for the
      // operator to click. Written to the TERMINAL ONLY — the rotating log
      // tees stdout, and the token must never land in a log file.
      if (cliArgs.printUrl) {
        writeUnlogged(`Sign in: ${signInLink(base, AUTH_TOKEN)}\n`);
      }

      // ADR-029 mutual exclusion: claim the pid file. This is the
      // contract that prevents two servers from competing for the same
      // ~/.autonomos/ state (the PR #172 bug).
      //
      // CRITICAL ordering: gateway init, resumeActiveAgents, and
      // initScheduler MUST run inside the "acquired" branch only. The
      // earlier version fired acquireOwnership without awaiting + ran
      // those side-effect inits synchronously below, which meant the
      // "already-running" branch could win the file check AFTER PTYs
      // had already been respawned into the legitimate owner's state.
      // That's the PR #172 PTY-corruption bug, narrower timing window.
      acquireOwnership(process.pid, actualPort, getServerVersion())
        .then((result) => {
          if (result.status === "already-running") {
            // Another server already owns this config dir. Close our
            // socket (we already bound a port we won't use) and exit
            // gracefully with a message the caller can parse.
            // We DID NOT spawn PTYs or arm timers yet — those live in
            // the "acquired" branch below.
            console.warn(
              `[startup] Another autonomos-server is already running ` +
                `(pid ${result.owner.pid}, port ${result.owner.port}, ` +
                `version ${result.owner.version}). Connect to it instead.`,
            );
            server.close(() => process.exit(0));
            return;
          }

          // We are the owner. Arm the destructive inits.
          void armRuntimeInits();
        })
        .catch((err) => {
          console.warn(
            "[startup] Failed to acquire pid-file ownership — proceeding " +
              "without mutual exclusion (the `autonomos status/stop` CLI " +
              "won't work):",
            err instanceof Error ? err.message : err,
          );
          // Acquisition failed but we're proceeding — arm the inits as
          // we would in the "acquired" branch. This preserves the prior
          // behavior of "graceful degradation" when the lock can't be
          // acquired for some unrelated reason (filesystem error, etc).
          //
          // The control socket's own liveness probe still applies here: if a
          // live server holds it, startInternalControlPlane refuses rather
          // than stealing it, which is the protection the unacquired pid file
          // failed to give us.
          void armRuntimeInits();
        });
    },
  );

  injectWebSocket(server);

  // Clean up all PTY processes on shutdown. Agents stay in persistence as
  // "running" so they auto-resume on next boot.
  const exitProcess = (): void => {
    try {
      // Release the pid file (claimed via acquireOwnership at startup),
      // per ADR-029.
      removePidFile();
      // Unlink the control socket. A Unix socket file outlives its process, and
      // a leftover one makes the next boot's bind fail EADDRINUSE — the next
      // start recovers via the stale-socket probe, but only after logging a
      // warning that implies an unclean shutdown. Clean up when we can.
      internalServer.close();
      removeControlSocket(controlSocketPath);
    } finally {
      process.exit(0);
    }
  };
  const shutdown = createShutdownHandler({
    stopWork: stopScheduler,
    teardownAgents: shutdownAllAttachments,
    // Agent processes and their sidecar daemons, in parallel, same bound.
    awaitDaemons: async () => {
      const [daemons, ptys] = await Promise.all([
        stopAllSidecars(),
        awaitPtyExits(SIDECAR_EXIT_CAP_MS),
      ]);
      if (ptys.length > 0) {
        console.warn(
          `[shutdown] agent process(es) still alive after SIGKILL: ${ptys.join(", ")} — they may outlive the server`,
        );
      }
      return daemons;
    },
    exitProcess,
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  installUnhandledRejectionLogger();

  // The server is now running. Return a promise that never resolves —
  // shutdown happens via signal → process.exit() above.
  return new Promise<void>(() => {});
}

/**
 * Refuse a weak token on a NEW network-bound install; warn loudly on every
 * boot otherwise (V2b, ADR-130). Never prints the token.
 */
function enforceTokenStrength(o: {
  token: string;
  source: TokenSource;
  priorInstall: boolean;
  networkBind: boolean;
  allowWeak: boolean;
}): void {
  const weak = isWeakToken(o.token);
  const policy = weakTokenPolicy({ weak, ...o });
  const fromEnv = o.source === "env";
  const where = fromEnv
    ? "the AUTONOMOS_TOKEN environment variable (e.g. a .env file)"
    : "the token file";
  if (policy === "refuse") {
    const message = [
      `✖ Refusing to start: the operator token from ${where} is only ${o.token.length} characters (or too repetitive), and this new install listens on the network.`,
      "  Anyone who can reach the port could guess it.",
      fromEnv
        ? "  Remove AUTONOMOS_TOKEN to let autonomOS generate a strong token, or set a 32+ character random one."
        : "  Delete the token file to let autonomOS generate a strong one, or write a 32+ character random token.",
      "  To listen on this machine only, pass --host=127.0.0.1. To start anyway, pass --allow-weak-token.",
    ].join("\n");
    console.error(message); // → the log file (and the terminal, on a TTY)
    // Off a TTY the logger doesn't echo stderr, so a refused start under a
    // supervisor or a script would exit 2 in silence. Say it on the real fd 2.
    if (!process.stderr.isTTY) writeSync(2, `${message}\n`);
    process.exit(2);
  }
  if (policy === "warn") {
    // One informational line: the operator may keep a short token on purpose
    // (Terry, 2026-10-01). The throttle (ADR-124) and the new-device lock
    // (ADR-135) are what protect it; nothing nags.
    console.log(
      `ℹ The operator token is short (${o.token.length} characters): new devices get ${newDeviceFailureLimit(process.env.AUTONOMOS_NEW_DEVICE_FAILURE_LIMIT)} failed sign-ins in total before they're locked out. \`autonomos token rotate\` replaces it.`,
    );
  }
}

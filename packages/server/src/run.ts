// `runServer(argv)` — the autonomos-server startup logic, exposed as a callable
// function so the CLI (`autonomos start`) and the standalone entry point
// (`packages/server/src/index.ts`) can both invoke it without duplicating
// logic.
//
// Behavior identical to the pre-Phase-1C top-level startup. The single
// addition: it writes a PID file at $configDir/autonomos.pid for the CLI's
// stop/status/upgrade commands to consume.

import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { HostInfo } from "@autonomos/core";
import { createAdaptorServer, serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { sweepAgentTokenFiles } from "./agentCredentials.js";
import { migrateIfNeeded } from "./agents/migrate.js";
import {
  resumeActiveAgents,
  shutdownAllAttachments,
} from "./agents/runtime.js";
import { resolveAuthToken } from "./auth.js";
import { parseCliArgs, printUsage } from "./cli-args.js";
import { readDashboardBuild } from "./dashboardBuild.js";
import {
  assertUsableSocketPath,
  getControlSocketPath,
  prepareControlSocket,
  removeControlSocket,
  restrictControlSocket,
} from "./internalSocket.js";
import { initFileLogging } from "./logger.js";
import { handleMcpRequest, handleMcpSessionRequest } from "./mcp.js";
import { acquireOwnership, removePidFile } from "./pid-file.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
import { codexUsageRouter } from "./plugins/codex-usage/route.js";
import { writeGeminiSettings } from "./providers/gemini-cli.js";
import { getAllProviders, isProviderInstalled } from "./providers/index.js";
import { agentsRouter } from "./routes/agents.js";
import { channelsRouter } from "./routes/channels.js";
import { envPresetRouter } from "./routes/env-presets.js";
import { gatewayRouter } from "./routes/gateway.js";
import { hooksIngestRouter, hooksReadRouter } from "./routes/hooks.js";
import { projectRouter } from "./routes/projects.js";
import { providerRouter } from "./routes/providers.js";
import { scheduleRouter, schedulerRouter } from "./routes/schedules.js";
import { settingsRouter } from "./routes/settings.js";
import { systemRouter } from "./routes/system.js";
import { templateRouter } from "./routes/templates.js";
import { terminalRouter } from "./routes/terminal.js";
import { usageQueueRouter } from "./routes/usageQueue.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import { CHANNEL_SERVER_SCRIPT, STATUSLINE_SCRIPT } from "./scriptPaths.js";
import {
  setAuthToken,
  setInternalSocketPath,
  setServerPort,
} from "./serverState.js";
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

  // Tee stdout/stderr into a rotating $configDir/logs/autonomos.log as early as
  // possible, so everything below is captured under OS-native supervision (the
  // supervisor's own stdout goes to /dev/null — see service-templates.ts). Best
  // effort: a logging failure never blocks startup.
  initFileLogging();

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

  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // The internal control plane (ADR-055). A SEPARATE Hono app served over a
  // Unix domain socket rather than the public TCP listener, so the routes that
  // exist for autonomOS's own processes — `/mcp`, `/api/hooks`, and (PR B)
  // `/ws/gateway` — are simply not reachable from the network. Not "reachable
  // but rejected": there is no port to connect to. The public listener below
  // keeps only the browser surface.
  const internalApp = new Hono<NodeEnv>();

  // Per-app WebSocket closures for the internal listener. createNodeWebSocket
  // returns per-app upgrade/inject functions — calling it a second time for
  // internalApp does NOT conflict with the public app's pair above (no shared
  // singleton). iInject is wired to internalServer once it exists (below).
  const { upgradeWebSocket: iUpgrade, injectWebSocket: iInject } =
    createNodeWebSocket({ app: internalApp });

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

  const corsOrigin =
    process.env.CORS_ORIGIN ||
    (isProduction ? undefined : "http://localhost:5173");
  if (corsOrigin) {
    app.use("*", cors({ origin: corsOrigin }));
  }

  const AUTH_TOKEN = resolveAuthToken();
  // Publish to serverState so spawn-time code (runtime.ts, providers/*) can read
  // the in-process token without round-tripping through env or disk.
  setAuthToken(AUTH_TOKEN);

  function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  function extractToken(c: Context): string | undefined {
    const cookie = getCookie(c, "autonomos_token");
    if (cookie) return cookie;
    const header = c.req.header("Authorization");
    if (header?.startsWith("Bearer ")) return header.slice(7);
    return undefined;
  }

  app.post("/auth", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token : null;
    if (!token || !safeEqual(token, AUTH_TOKEN)) {
      return c.json({ error: "Invalid token" }, 401);
    }
    const isHttps =
      c.req.url.startsWith("https://") ||
      c.req.header("x-forwarded-proto") === "https";
    setCookie(c, "autonomos_token", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps,
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return c.json({ ok: true });
  });

  const requireAuth: MiddlewareHandler = async (c, next) => {
    // NOTE: the `POST /api/hooks/*` exemption is GONE (ADR-055). Hook ingestion
    // moved to the internal socket, so nothing on the public listener needs to
    // accept an unauthenticated write any more. The exemption was also wider
    // than its purpose — it covered the dashboard's `POST /api/hooks/:id/read`
    // too. Removing it means there is no unauthenticated POST anywhere on the
    // public surface; the browser already sends the token for /read.
    if (c.req.method === "GET" && c.req.path === "/api/host") return next();
    const token = extractToken(c) ?? c.req.query("token") ?? undefined;
    if (token && safeEqual(token, AUTH_TOKEN)) return next();
    return c.json(
      {
        error:
          "Unauthorized — open the dashboard and paste your token at the login screen",
      },
      401,
    );
  };

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
    : requireAuth;

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

  app.get("/api/host", (c) =>
    c.json({
      hostname: hostname(),
      dashboard: dashboardBuild,
    } satisfies HostInfo),
  );

  // Hook INGEST is internal-only; the hook READ surface stays public because
  // the dashboard (a browser, not an agent) is what calls it. See routes/hooks.ts.
  internalApp.route("/api/hooks", hooksIngestRouter);
  app.route("/api/hooks", hooksReadRouter);

  // REST API (behind auth)
  app.route("/api/projects", projectRouter);
  app.route("/api/agents", agentsRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/channels", channelsRouter);
  app.route("/api/templates", templateRouter);
  app.route("/api/env-presets", envPresetRouter);
  app.route("/api/providers", providerRouter);
  app.route("/api/schedules", scheduleRouter);
  app.route("/api/scheduler", schedulerRouter);
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
  internalApp.use("/ws/gateway", requireAuth);
  internalApp.get("/ws/gateway", gatewayRouter(iUpgrade));

  if (isProduction && dashboardDist !== null) {
    console.log(
      `Serving dashboard from ${dashboardDist} ` +
        `(build ${dashboardBuild?.build ?? "?"}, built ${dashboardBuild?.builtAt ?? "?"})`,
    );

    app.all("/api/*", (c) =>
      c.json({ error: `Not found: ${c.req.path}` }, 404),
    );
    app.all("/ws/*", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));
    // /mcp is internal-socket-only (ADR-055) and has no public handler. This
    // must stay: without it the SPA catch-all below would answer a public
    // /mcp probe with index.html, which reads like "the endpoint is here" to
    // anyone scanning. 404 is the honest answer.
    app.all("/mcp", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));

    app.use("/*", serveStatic({ root: dashboardDist }));

    const indexHtml = readFileSync(
      resolve(dashboardDist, "index.html"),
      "utf-8",
    );
    app.get("*", (c) => c.html(indexHtml));
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

    // Initialize gateway (platform adapters, routing table).
    const { initGateway } = await import("./gateway/index.js");
    initGateway().catch((err) => console.error("[gateway] init failed:", err));

    // Background update-availability check (ADR-077 §6): first run minutes
    // after boot, then ~daily; unref'd timer, settings-gated, never touches
    // a request path. The dashboard badge reads its cache off
    // /api/system/version.
    const { startUpdateCheck } = await import("./updateCheck.js");
    startUpdateCheck();

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
    void resumeActiveAgents()
      .catch((err) =>
        console.error("[startup] resumeActiveAgents failed:", err),
      )
      .finally(() => initScheduler());
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
      console.log(
        `Auth token: ${AUTH_TOKEN.slice(0, 4)}...${AUTH_TOKEN.slice(-4)}`,
      );

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

      // --print-url: emit the full URL + token in one human-readable line
      // suitable for copy-paste to connect a browser or client.
      if (cliArgs.printUrl) {
        console.log(`URL: ${base}  token: ${AUTH_TOKEN}`);
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
  const shutdown = (): void => {
    console.log(
      "Shutting down — killing PTYs (agents will resume on next start)...",
    );
    stopScheduler();
    shutdownAllAttachments();
    // Release the pid file (claimed via acquireOwnership at startup),
    // per ADR-029.
    removePidFile();
    // Unlink the control socket. A Unix socket file outlives its process, and
    // a leftover one makes the next boot's bind fail EADDRINUSE — the next
    // start recovers via the stale-socket probe, but only after logging a
    // warning that implies an unclean shutdown. Clean up when we can.
    internalServer.close();
    removeControlSocket(controlSocketPath);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The server is now running. Return a promise that never resolves —
  // shutdown happens via signal → process.exit() above.
  return new Promise<void>(() => {});
}

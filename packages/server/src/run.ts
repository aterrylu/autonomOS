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
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { migrateIfNeeded } from "./agents/migrate.js";
import {
  resumeActiveAgents,
  shutdownAllAttachments,
} from "./agents/runtime.js";
import { resolveAuthToken } from "./auth.js";
import { parseCliArgs, printUsage } from "./cli-args.js";
import { readDashboardBuild } from "./dashboardBuild.js";
import { initFileLogging } from "./logger.js";
import { handleMcpRequest, handleMcpSessionRequest } from "./mcp.js";
import { acquireOwnership, removePidFile } from "./pid-file.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
import { codexUsageRouter } from "./plugins/codex-usage/route.js";
import { writeGeminiSettings } from "./providers/gemini-cli.js";
import { getAllProviders, isProviderInstalled } from "./providers/index.js";
import { agentsRouter } from "./routes/agents.js";
import { channelsRouter } from "./routes/channels.js";
import { fileRouter, fileWatchRouter } from "./routes/files.js";
import { gatewayRouter } from "./routes/gateway.js";
import { hooksRouter } from "./routes/hooks.js";
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
import { setAuthToken, setServerPort } from "./serverState.js";
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
 * True when the server is bound to a loopback interface — i.e. reachable from
 * this machine but not from the network. An undefined bind host defaults to
 * `localhost`. Exported for tests.
 *
 * This is defense-in-depth for the startup warning, NOT an auth mechanism.
 * Auth is required on every route regardless of bind; do not reintroduce
 * "trusted because loopback" exemptions on top of this (see ADR-041's note on
 * unconditional auth-exempt endpoints being a credential-injection vector).
 */
export function isLoopbackBind(bindHost: string | undefined): boolean {
  const host = bindHost ?? "localhost";
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Resolve the interface to bind. Precedence: --host > AUTONOMOS_HOST > loopback.
 *
 * The default is loopback, not all-interfaces. Node's `listen()` with no host
 * binds `::`/`0.0.0.0`, which put the dashboard — and every agent it can spawn —
 * on whatever network the machine is attached to. Opting into exposure is a
 * decision the operator makes explicitly.
 *
 * Uses AUTONOMOS_HOST rather than HOST: bare `HOST` is set by unrelated tooling
 * on some systems, and inheriting it here would silently move the bind.
 * Exported for tests.
 */
export function resolveBindHost(
  cliHost: string | undefined,
  envHost: string | undefined,
): string {
  const host = stripSurroundingQuotes((cliHost ?? envHost ?? "").trim());
  return host ? host : "127.0.0.1";
}

// `tsx --env-file` (the prod wrapper) and hand-quoted service-file args pass
// `AUTONOMOS_HOST="0.0.0.0"` through WITH the quote characters, and a hostname
// carrying quotes fails `serve()` with ENOTFOUND — a crash-loop on the exact
// deploy where someone is enabling network exposure. A hostname/IP never
// legitimately contains a surrounding quote pair, so peeling one matched pair
// is safe and turns a habitual `.env` quoting mistake into the intended bind.
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

  // Write Gemini CLI settings file (hooks + MCP config) if Gemini is installed
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
    if (c.req.method === "POST" && c.req.path.startsWith("/api/hooks/"))
      return next();
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

  app.use("/api/*", requireAuth);
  app.use("/ws/*", requireAuth);
  // /mcp exposes the same orchestration tools as the dashboard API —
  // create_agent, kill_agent, set_manager. It is NOT a public transport.
  // Mounted here (before the route definitions below) so every method is
  // covered; a client authenticates with the same token as everything else.
  app.use("/mcp", requireAuth);

  app.get("/api/host", (c) =>
    c.json({ hostname: hostname(), dashboard: dashboardBuild }),
  );

  app.route("/api/hooks", hooksRouter);

  // REST API (behind auth)
  app.route("/api/files", fileRouter);
  app.route("/api/projects", projectRouter);
  app.route("/api/agents", agentsRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/channels", channelsRouter);
  app.route("/api/templates", templateRouter);
  app.route("/api/providers", providerRouter);
  app.route("/api/schedules", scheduleRouter);
  app.route("/api/scheduler", schedulerRouter);
  app.route("/api/plugins/claude-usage", claudeUsageRouter);
  app.route("/api/plugins/codex-usage", codexUsageRouter);
  app.route("/api/usage-queue", usageQueueRouter);
  app.route("/api/system", systemRouter);

  // MCP — Streamable HTTP transport for agent-to-agent communication
  app.post("/mcp", async (c) => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    const body = await c.req.json().catch(() => undefined);
    await handleMcpRequest(req, res, body);
    return new Response(null);
  });
  app.get("/mcp", async (c) => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    await handleMcpSessionRequest(req, res);
    return new Response(null);
  });
  app.delete("/mcp", async (c) => {
    const req = c.env.incoming as IncomingMessage;
    const res = c.env.outgoing as ServerResponse;
    await handleMcpSessionRequest(req, res);
    return new Response(null);
  });

  // WebSocket — terminal PTY streaming, file watching, gateway, agent deltas
  app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
  app.get("/ws/files/watch", fileWatchRouter(upgradeWebSocket));
  app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));
  app.get("/ws/agents", agentsWsRouter(upgradeWebSocket));

  if (isProduction && dashboardDist !== null) {
    console.log(
      `Serving dashboard from ${dashboardDist} ` +
        `(build ${dashboardBuild?.build ?? "?"}, built ${dashboardBuild?.builtAt ?? "?"})`,
    );

    app.all("/api/*", (c) =>
      c.json({ error: `Not found: ${c.req.path}` }, 404),
    );
    app.all("/ws/*", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));
    app.all("/mcp", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));

    app.use("/*", serveStatic({ root: dashboardDist }));

    const indexHtml = readFileSync(
      resolve(dashboardDist, "index.html"),
      "utf-8",
    );
    app.get("*", (c) => c.html(indexHtml));
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

      // An exposed bind is legitimate (a remote always-on box you browse to),
      // but it should never be a surprise.
      //
      // Be precise about what auth covers. `requireAuth` exempts
      // POST /api/hooks/* and GET /api/host unconditionally (see the exemptions
      // above), so "everything needs a token" would be a comforting lie told at
      // the exact moment someone decides whether to expose the port. Name the
      // residual surface until those are authenticated too.
      if (!isLoopbackBind(bindHost)) {
        console.warn(
          `⚠️  Bound to ${bindHost}:${actualPort} — reachable from the network, ` +
            `not just this machine.\n` +
            `    The dashboard API, WebSocket and MCP routes require the auth ` +
            `token.\n` +
            `    Still UNAUTHENTICATED: POST /api/hooks/* (can forge agent ` +
            `status and inject\n` +
            `    dashboard notifications) and GET /api/host (hostname). Only ` +
            `expose this on a\n` +
            `    network you trust.\n` +
            `    Omit --host / AUTONOMOS_HOST to bind loopback-only.`,
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

          // Initialize gateway (platform adapters, routing table).
          import("./gateway/index.js").then(({ initGateway }) => {
            initGateway().catch((err) =>
              console.error("[gateway] init failed:", err),
            );
          });

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
          import("./gateway/index.js").then(({ initGateway }) => {
            initGateway().catch((gwErr) =>
              console.error("[gateway] init failed:", gwErr),
            );
          });
          void resumeActiveAgents()
            .catch((err) =>
              console.error("[startup] resumeActiveAgents failed:", err),
            )
            .finally(() => initScheduler());
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
    import("./gateway/index.js")
      .then(({ shutdownGateway }) => shutdownGateway())
      .catch(() => {});
    shutdownAllAttachments();
    // Release the pid file (claimed via acquireOwnership at startup),
    // per ADR-029.
    removePidFile();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The server is now running. Return a promise that never resolves —
  // shutdown happens via signal → process.exit() above.
  return new Promise<void>(() => {});
}

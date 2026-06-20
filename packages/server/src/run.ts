// `runServer(argv)` — the autonomos-server startup logic, exposed as a callable
// function so the CLI (`autonomos start`) and the standalone entry point
// (`packages/server/src/index.ts`, used by Phase 1B Electron) can both invoke
// it without duplicating logic.
//
// Behavior identical to the pre-Phase-1C top-level startup. The single
// addition: when running in standalone (non-embedded) mode, writes a PID
// file at $configDir/autonomos.pid for the CLI's stop/status/upgrade commands
// to consume.

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
import {
  announceEmbeddedReady,
  resolveEmbeddedConfig,
} from "./embedded-mode.js";
import { handleMcpRequest, handleMcpSessionRequest } from "./mcp.js";
import { acquireOwnership, removePidFile } from "./pid-file.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
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
  const embeddedConfig = resolveEmbeddedConfig(cliArgs.embedded);

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
  // Process-manager-agnostic: works under pm2, npx, bun, manual node, or
  // desktop-bootstrapped SSH server.
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
      { error: "Unauthorized — visit /auth?token=YOUR_TOKEN to authenticate" },
      401,
    );
  };

  app.use("/api/*", requireAuth);
  app.use("/ws/*", requireAuth);

  app.get("/api/host", (c) => c.json({ hostname: hostname() }));

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
    console.log(`Serving dashboard from ${dashboardDist}`);

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
  // --port=0 asks the OS to assign a free port (used in embedded mode).
  const requestedPort = cliArgs.port ?? (Number(process.env.PORT) || 3000);

  const server = serve(
    {
      fetch: app.fetch,
      port: requestedPort,
      hostname: embeddedConfig.bindHost,
    },
    () => {
      // When --port=0 the OS assigned us a real port; read it from the listener.
      const addr = server.address() as AddressInfo | null;
      const actualPort = addr?.port ?? requestedPort;
      // Publish the OS-assigned port to serverState. Without this, spawned
      // Claude Code sessions (runtime.ts:spawnAgent → providers/*.buildArgs)
      // would still read `process.env.PORT || "3000"` and bake the wrong URL
      // into their hook + MCP-gateway endpoints. In Built-in (embedded) mode
      // we boot with --port=0, so actualPort is an ephemeral assignment.
      setServerPort(actualPort);
      const host = embeddedConfig.bindHost ?? "localhost";
      const base = `http://${host}:${actualPort}`;
      console.log(`autonomOS server listening on ${base}`);
      console.log(
        `Auth token: ${AUTH_TOKEN.slice(0, 4)}...${AUTH_TOKEN.slice(-4)}`,
      );

      // --print-url: emit the full URL + token in one human-readable line
      // suitable for copy-paste into the Desktop's "Add server" dialog.
      // The Welcome flow's Add-server modal references this command.
      if (cliArgs.printUrl) {
        console.log(`URL: ${base}  token: ${AUTH_TOKEN}`);
      }

      // ADR-029 mutual exclusion: BOTH embedded and standalone modes
      // must claim the pid file. This is the contract that prevents two
      // servers from competing for the same ~/.autonomos/ state (the PR
      // #172 bug).
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
            if (cliArgs.embedded) {
              // Embedded contract: tell the parent Electron process the
              // existing port so it can switch to thin-client mode
              // instead of treating this as a startup failure.
              process.stdout.write(
                `AUTONOMOS_ALREADY_RUNNING port=${result.owner.port} ` +
                  `pid=${result.owner.pid}\n`,
              );
            }
            server.close(() => process.exit(0));
            return;
          }

          // We are the owner. Emit the readiness signal (embedded mode)
          // or just log (standalone mode), then arm the destructive
          // inits.
          if (cliArgs.embedded) {
            announceEmbeddedReady(actualPort);
          }

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
          resumeActiveAgents();

          // Start scheduler AFTER agents are up so agent:<name> targets
          // resolve. Arms timers that write into ~/.autonomos/ — must NOT
          // run if we lost the claim.
          initScheduler();
        })
        .catch((err) => {
          console.warn(
            "[startup] Failed to acquire pid-file ownership — proceeding " +
              "without mutual exclusion (the `autonomos status/stop` CLI " +
              "and Desktop mode-detection won't work):",
            err instanceof Error ? err.message : err,
          );
          // Still emit ready in embedded mode so the parent doesn't hang.
          if (cliArgs.embedded) {
            announceEmbeddedReady(actualPort);
          }
          // Acquisition failed but we're proceeding — arm the inits as
          // we would in the "acquired" branch. This preserves the prior
          // behavior of "graceful degradation" when the lock can't be
          // acquired for some unrelated reason (filesystem error, etc).
          import("./gateway/index.js").then(({ initGateway }) => {
            initGateway().catch((gwErr) =>
              console.error("[gateway] init failed:", gwErr),
            );
          });
          resumeActiveAgents();
          initScheduler();
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
    // Release the pid file (claimed via acquireOwnership at startup).
    // This is now done in BOTH embedded and standalone modes per ADR-029.
    removePidFile();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The server is now running. Return a promise that never resolves —
  // shutdown happens via signal → process.exit() above.
  return new Promise<void>(() => {});
}

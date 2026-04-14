import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { resolveAuthToken } from "./auth.js";
import { handleMcpRequest, handleMcpSessionRequest } from "./mcp.js";
import { getPersistedSessions } from "./persisted.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
import { conversationRouter } from "./routes/conversation.js";
import { fileRouter, fileWatchRouter } from "./routes/files.js";
import { gatewayRouter } from "./routes/gateway.js";
import { orgRouter, templateRouter } from "./routes/hierarchy.js";
import { hooksRouter } from "./routes/hooks.js";
import { projectRouter } from "./routes/projects.js";
import { scheduleRouter, schedulerRouter } from "./routes/schedules.js";
import { sessionRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { terminalRouter } from "./routes/terminal.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import {
  createSession,
  resolveClaudePath,
  shutdownAllSessions,
} from "./sessions.js";
import { getTemplate } from "./templates.js";

// Validate claude binary exists at startup — fail fast with a clear message
try {
  const path = resolveClaudePath();
  console.log(`Claude binary found: ${path}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

type NodeEnv = {
  Bindings: {
    incoming: IncomingMessage;
    outgoing: ServerResponse;
  };
};

const app = new Hono<NodeEnv>();

const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

// Serve dashboard static files in production
const dashboardDist = resolve(import.meta.dirname, "../../dashboard/dist");
const isProduction = existsSync(dashboardDist);

// In production (serving dashboard from same origin), CORS is unnecessary.
// In dev, allow the Vite dev server origin.
const corsOrigin =
  process.env.CORS_ORIGIN ||
  (isProduction ? undefined : "http://localhost:5173");
if (corsOrigin) {
  app.use("*", cors({ origin: corsOrigin }));
}

// Auth is always enabled — token resolved from env var, file, or auto-generated
const AUTH_TOKEN = resolveAuthToken();

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

// Token exchange: POST { token } sets a cookie and returns 200
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
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return c.json({ ok: true });
});

// Protect API and WS routes — static assets pass through so the
// dashboard can load and show a "not authenticated" state.
const requireAuth: MiddlewareHandler = async (c, next) => {
  // Hook relay POST is unauthenticated (called from PTY sessions via curl).
  if (c.req.method === "POST" && c.req.path.startsWith("/api/hooks/"))
    return next();
  // Host info is unauthenticated — used by dashboard status bar before login.
  if (c.req.method === "GET" && c.req.path === "/api/host") return next();
  // Accept token from cookie, Authorization header, or ?token= query param.
  // Query param is used by the channel server subprocess (can't set headers on WebSocket).
  const token = extractToken(c) ?? c.req.query("token") ?? undefined;
  if (token && safeEqual(token, AUTH_TOKEN)) return next();
  return c.json(
    { error: "Unauthorized — visit /auth?token=YOUR_TOKEN to authenticate" },
    401,
  );
};

app.use("/api/*", requireAuth);
app.use("/ws/*", requireAuth);

// Server info — lightweight, no auth required for status bar
app.get("/api/host", (c) => c.json({ hostname: hostname() }));

// Hook relay — no auth (called from PTY sessions via curl, no cookie available).
// POST only accepts events; GET endpoints are behind auth via the wildcard above.
app.route("/api/hooks", hooksRouter);

// REST API (behind auth)
app.route("/api/conversation", conversationRouter);
app.route("/api/files", fileRouter);
app.route("/api/projects", projectRouter);
app.route("/api/org", orgRouter);
app.route("/api/sessions", sessionRouter);
app.route("/api/settings", settingsRouter);
app.route("/api/templates", templateRouter);
app.route("/api/schedules", scheduleRouter);
app.route("/api/scheduler", schedulerRouter);
app.route("/api/plugins/claude-usage", claudeUsageRouter);

// MCP — Streamable HTTP transport for agent-to-agent communication
app.post("/mcp", async (c) => {
  const req = c.env.incoming as IncomingMessage;
  const res = c.env.outgoing as ServerResponse;
  const body = await c.req.json().catch(() => undefined);
  await handleMcpRequest(req, res, body);
  // Response already sent by MCP transport — return empty to avoid double-write
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

// WebSocket — terminal PTY streaming, file watching, gateway channels
app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
app.get("/ws/files/watch", fileWatchRouter(upgradeWebSocket));
app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));

if (isProduction) {
  console.log(`Serving dashboard from ${dashboardDist}`);

  // JSON 404 for unmatched API/WS/MCP routes (all methods).
  // Must be registered BEFORE serveStatic so it takes priority.
  app.all("/api/*", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));
  app.all("/ws/*", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));
  app.all("/mcp", (c) => c.json({ error: `Not found: ${c.req.path}` }, 404));

  // Serve static dashboard assets (JS, CSS, images)
  app.use("/*", serveStatic({ root: dashboardDist }));

  // SPA fallback — serve index.html for page routes
  const indexHtml = readFileSync(resolve(dashboardDist, "index.html"), "utf-8");
  app.get("*", (c) => c.html(indexHtml));
}

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port }, () => {
  const base = `http://localhost:${port}`;
  console.log(`autonomOS server listening on ${base}`);
  console.log(
    `Auth token: ${AUTH_TOKEN.slice(0, 4)}...${AUTH_TOKEN.slice(-4)}`,
  );

  // Initialize gateway (platform adapters, routing table)
  import("./gateway/index.js").then(({ initGateway }) => {
    initGateway().catch((err) => console.error("[gateway] init failed:", err));
  });

  // Auto-resume persisted sessions after startup
  resumePersistedSessions();

  // Start scheduler AFTER sessions are up so agent:<name> targets resolve
  initScheduler();
});

injectWebSocket(server);

function resumePersistedSessions() {
  const persisted = getPersistedSessions();
  if (persisted.length === 0) return;

  const toResume = persisted.filter((p) => p.status !== "exited");
  const exitedCount = persisted.length - toResume.length;
  if (exitedCount > 0) {
    console.log(`  Skipping ${exitedCount} exited session(s)`);
  }
  if (toResume.length === 0) return;

  console.log(`Resuming ${toResume.length} session(s)...`);
  let resumed = 0;
  for (const p of toResume) {
    try {
      // Re-resolve template system prompt so agents keep their role context
      const tmpl = p.template ? getTemplate(p.template) : null;
      if (p.template && !tmpl) {
        console.warn(
          `  ⚠ Template "${p.template}" not found for ${p.name} — agent will resume without role context`,
        );
      }

      createSession({
        workingDirectory: p.workingDirectory,
        resumeSessionId: p.claudeSessionId,
        name: p.name,
        autonomousMode: p.autonomousMode,
        appendSystemPrompt: tmpl?.systemPrompt,
        template: p.template,
        manager: p.manager,
        project: p.project,
      });
      console.log(`  ✓ ${p.name} (${p.claudeSessionId.slice(0, 8)}...)`);
      resumed++;
    } catch (err) {
      console.error(
        `  ✗ Failed to resume ${p.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (resumed < toResume.length) {
    console.warn(`Resumed ${resumed} of ${toResume.length} sessions`);
  }
}

// Clean up all PTY processes on shutdown
function shutdown() {
  console.log(
    "Shutting down — killing PTYs (sessions will resume on next start)...",
  );
  stopScheduler();
  import("./gateway/index.js")
    .then(({ shutdownGateway }) => shutdownGateway())
    .catch(() => {});
  shutdownAllSessions();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

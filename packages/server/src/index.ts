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
import { handleMcpRequest, handleMcpSessionRequest } from "./mcp.js";
import { getPersistedSessions } from "./persisted.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
import { fileRouter, fileWatchRouter } from "./routes/files.js";
import { projectRouter } from "./routes/projects.js";
import { sessionRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { terminalRouter } from "./routes/terminal.js";
import {
  createSession,
  resolveClaudePath,
  shutdownAllSessions,
} from "./sessions.js";

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

// Optional token auth — enabled when AUTONOMOS_TOKEN is set
const AUTH_TOKEN = process.env.AUTONOMOS_TOKEN?.trim() || undefined;

if (process.env.AUTONOMOS_TOKEN && !AUTH_TOKEN) {
  console.warn("AUTONOMOS_TOKEN is empty/whitespace — auth is DISABLED.");
} else if (AUTH_TOKEN && AUTH_TOKEN.length < 8) {
  console.warn(
    `AUTONOMOS_TOKEN is only ${AUTH_TOKEN.length} chars — consider using a longer token.`,
  );
}

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

if (AUTH_TOKEN) {
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
    const token = extractToken(c);
    if (token && safeEqual(token, AUTH_TOKEN)) return next();
    return c.json(
      { error: "Unauthorized — visit /auth?token=YOUR_TOKEN to authenticate" },
      401,
    );
  };

  app.use("/api/*", requireAuth);
  app.use("/ws/*", requireAuth);
}

// Server info — lightweight, no auth required for status bar
app.get("/api/host", (c) => c.json({ hostname: hostname() }));

// REST API
app.route("/api/files", fileRouter);
app.route("/api/projects", projectRouter);
app.route("/api/sessions", sessionRouter);
app.route("/api/settings", settingsRouter);
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

// WebSocket — terminal PTY streaming + file watching
app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
app.get("/ws/files/watch", fileWatchRouter(upgradeWebSocket));

if (isProduction) {
  console.log(`Serving dashboard from ${dashboardDist}`);
  app.use("/*", serveStatic({ root: dashboardDist }));

  // SPA fallback — serve index.html for non-API/WS/MCP routes
  const indexHtml = readFileSync(resolve(dashboardDist, "index.html"), "utf-8");
  app.get("*", (c) => {
    const path = c.req.path;
    if (path.startsWith("/api/") || path.startsWith("/ws/") || path === "/mcp") {
      return c.json({ error: "Not found" }, 404);
    }
    return c.html(indexHtml);
  });
}

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port }, () => {
  const base = `http://localhost:${port}`;
  console.log(`autonomOS server listening on ${base}`);
  if (AUTH_TOKEN) {
    console.log(
      `Auth enabled (token: ${AUTH_TOKEN.slice(0, 4)}...${AUTH_TOKEN.slice(-4)})`,
    );
  } else {
    console.log(`Auth disabled — set AUTONOMOS_TOKEN to enable`);
  }

  // Auto-resume persisted sessions after startup
  resumePersistedSessions();
});

injectWebSocket(server);

function resumePersistedSessions() {
  const persisted = getPersistedSessions();
  if (persisted.length === 0) return;

  console.log(`Resuming ${persisted.length} session(s)...`);
  let resumed = 0;
  for (const p of persisted) {
    try {
      createSession({
        workingDirectory: p.workingDirectory,
        resumeSessionId: p.claudeSessionId,
        name: p.name,
        autonomousMode: p.autonomousMode,
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
  if (resumed < persisted.length) {
    console.warn(`Resumed ${resumed} of ${persisted.length} sessions`);
  }
}

// Clean up all PTY processes on shutdown
function shutdown() {
  console.log(
    "Shutting down — killing PTYs (sessions will resume on next start)...",
  );
  shutdownAllSessions();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

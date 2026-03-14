import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { getPinnedSessions } from "./pinned.js";
import { claudeUsageRouter } from "./plugins/claude-usage/route.js";
import { fileRouter, fileWatchRouter } from "./routes/files.js";
import { projectRouter } from "./routes/projects.js";
import { sessionRouter } from "./routes/sessions.js";
import { terminalRouter } from "./routes/terminal.js";
import {
  createSession,
  killAllSessions,
  resolveClaudePath,
} from "./sessions.js";

// Validate claude binary exists at startup — fail fast with a clear message
try {
  const path = resolveClaudePath();
  console.log(`Claude binary found: ${path}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = new Hono();

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
  // Token exchange: visiting /auth?token=xxx sets a cookie and redirects to /
  app.get("/auth", (c) => {
    const token = c.req.query("token");
    if (!token || !safeEqual(token, AUTH_TOKEN)) {
      return c.text("Invalid token", 401);
    }
    const hostname = new URL(c.req.url).hostname;
    setCookie(c, "autonomos_token", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: hostname !== "localhost" && hostname !== "127.0.0.1",
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });
    return c.redirect("/");
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

// REST API
app.route("/api/files", fileRouter);
app.route("/api/projects", projectRouter);
app.route("/api/sessions", sessionRouter);
app.route("/api/plugins/claude-usage", claudeUsageRouter);

// WebSocket — terminal PTY streaming + file watching
app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));
app.get("/ws/files/watch", fileWatchRouter(upgradeWebSocket));

if (isProduction) {
  console.log(`Serving dashboard from ${dashboardDist}`);
  app.use("/*", serveStatic({ root: dashboardDist }));

  // SPA fallback — serve index.html for non-API/WS routes
  const indexHtml = readFileSync(resolve(dashboardDist, "index.html"), "utf-8");
  app.get("*", (c) => c.html(indexHtml));
}

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port }, () => {
  const base = `http://localhost:${port}`;
  console.log(`autonomOS server listening on ${base}`);
  if (AUTH_TOKEN) {
    console.log(`Auth enabled — authenticate at:`);
    console.log(`  ${base}/auth?token=${AUTH_TOKEN}`);
  } else {
    console.log(`Auth disabled — set AUTONOMOS_TOKEN to enable`);
  }

  // Auto-resume pinned sessions after startup
  resumePinnedSessions();
});

injectWebSocket(server);

function resumePinnedSessions() {
  const pinned = getPinnedSessions();
  if (pinned.length === 0) return;

  console.log(`Resuming ${pinned.length} pinned session(s)...`);
  let resumed = 0;
  for (const p of pinned) {
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
  if (resumed < pinned.length) {
    console.warn(`Resumed ${resumed} of ${pinned.length} pinned sessions`);
  }
}

// Clean up all PTY processes on shutdown
function shutdown() {
  console.log("Shutting down — killing all sessions...");
  killAllSessions();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

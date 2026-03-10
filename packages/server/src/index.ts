import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { conversationRouter } from "./routes/conversation.js";
import { projectRouter } from "./routes/projects.js";
import { sessionRouter } from "./routes/sessions.js";
import { terminalRouter } from "./routes/terminal.js";
import { killAllSessions, resolveClaudePath } from "./sessions.js";

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

// REST API
app.route("/api/conversation", conversationRouter);
app.route("/api/projects", projectRouter);
app.route("/api/sessions", sessionRouter);

// WebSocket — terminal PTY streaming
app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));

if (isProduction) {
  console.log(`Serving dashboard from ${dashboardDist}`);
  app.use("/*", serveStatic({ root: dashboardDist }));

  // SPA fallback — serve index.html for non-API/WS routes
  const indexHtml = readFileSync(resolve(dashboardDist, "index.html"), "utf-8");
  app.get("*", (c) => c.html(indexHtml));
}

const port = Number(process.env.PORT) || 3000;

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`autonomOS server listening on http://localhost:${port}`);
});

injectWebSocket(server);

// Clean up all PTY processes on shutdown
function shutdown() {
  console.log("Shutting down — killing all sessions...");
  killAllSessions();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

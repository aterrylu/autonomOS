import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
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

app.use(
  "*",
  cors({ origin: process.env.CORS_ORIGIN || "http://localhost:5173" }),
);

app.get("/", (c) => c.json({ name: "autonomos", version: "0.0.1" }));

// REST API
app.route("/api/projects", projectRouter);
app.route("/api/sessions", sessionRouter);

// WebSocket — terminal PTY streaming
app.get("/ws/terminal/:sessionId", terminalRouter(upgradeWebSocket));

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

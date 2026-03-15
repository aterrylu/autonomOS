import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createSession, getAllSessions, killSession } from "./sessions.js";

// ── MCP Server ──────────────────────────────────────────────────────────
// Exposes autonomOS session management as MCP tools so any agent
// (Claude Code, OpenClaw, etc.) can discover and control sessions.

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "autonomos", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "autonomOS orchestrator — create and manage agent sessions across workspaces.",
    },
  );

  // ── Tool: create_session ────────────────────────────────────────────
  server.tool(
    "create_session",
    "Create a new autonomous agent session. Returns the session metadata including its ID.",
    {
      workingDirectory: z
        .string()
        .describe("Absolute path to the working directory (~ allowed)"),
      prompt: z
        .string()
        .optional()
        .describe("Initial prompt to send to the agent"),
      name: z.string().optional().describe("Display name for the session"),
      resumeSessionId: z
        .string()
        .optional()
        .describe("Claude Code session ID to resume"),
      autonomousMode: z
        .boolean()
        .optional()
        .default(true)
        .describe("Skip permission prompts (default: true)"),
    },
    async (args) => {
      try {
        const managed = createSession({
          workingDirectory: args.workingDirectory,
          prompt: args.prompt,
          name: args.name,
          resumeSessionId: args.resumeSessionId,
          autonomousMode: args.autonomousMode,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(managed.session, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to create session: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Tool: list_sessions ─────────────────────────────────────────────
  server.tool(
    "list_sessions",
    "List all active autonomOS sessions with their status, working directory, and metadata.",
    {},
    async () => {
      const sessions = getAllSessions();
      return {
        content: [
          {
            type: "text",
            text:
              sessions.length === 0
                ? "No active sessions."
                : JSON.stringify(sessions, null, 2),
          },
        ],
      };
    },
  );

  // ── Tool: kill_session ──────────────────────────────────────────────
  server.tool(
    "kill_session",
    "Terminate an active session by ID.",
    {
      sessionId: z.string().describe("The session ID to kill"),
    },
    async (args) => {
      const killed = killSession(args.sessionId);
      if (!killed) {
        return {
          content: [
            { type: "text", text: `Session ${args.sessionId} not found.` },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `Session ${args.sessionId} terminated.` },
        ],
      };
    },
  );

  return server;
}

// ── Transport / Session Management ────────────────────────────────────
// Stateful mode: each MCP client gets its own transport with a session ID.

const mcpServer = createMcpServer();
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Handle an incoming MCP request. Designed to be called from a Hono route
 * handler that has access to the raw Node.js req/res objects.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Reuse existing transport for established sessions
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, body);
    return;
  }

  // New session — only allow initialize requests
  if (body && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        console.log(`MCP session initialized: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        console.log(`MCP session closed: ${transport.sessionId}`);
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // Invalid request — no session and not an initialize
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing MCP session" },
      id: null,
    }),
  );
}

/**
 * Handle SSE GET or DELETE requests for existing MCP sessions.
 */
export async function handleMcpSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }
  res.writeHead(400, { "Content-Type": "text/plain" });
  res.end("Invalid or missing MCP session");
}

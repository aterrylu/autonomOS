import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_INSTRUCTIONS_EXTERNAL, MCP_SERVER_INFO } from "./mcp/tools.js";
import { createSession, getAllSessions, killSession } from "./sessions.js";

// ── MCP Server (HTTP transport — for external clients) ─────────────────
// Claude Desktop, CI pipelines, other MCP clients can connect here.
// Does NOT include `send` tool — that requires the gateway WebSocket.

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS_EXTERNAL,
    },
  );

  server.tool(
    "create_agent",
    "Create a new agent — a dedicated Claude Code session with a name, context, and optional task.",
    {
      workingDirectory: z
        .string()
        .describe("Absolute path to the working directory (~ allowed)"),
      name: z.string().optional().describe("Display name for the agent"),
      systemPrompt: z
        .string()
        .optional()
        .describe(
          "Instructions appended to the system prompt. Defines role/goals.",
        ),
      prompt: z
        .string()
        .optional()
        .describe("Initial task or message — what the agent starts working on"),
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
          appendSystemPrompt: args.systemPrompt,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(managed.session, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to create agent: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_agents",
    "List all active agents with their status, working directory, and metadata.",
    {},
    async () => {
      const sessions = getAllSessions();
      return {
        content: [
          {
            type: "text",
            text:
              sessions.length === 0
                ? "No active agents."
                : JSON.stringify(sessions, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "kill_agent",
    "Terminate an active agent by name or session ID.",
    {
      agent: z.string().describe("Agent name or session ID to terminate"),
    },
    async (args) => {
      // Try exact ID match first
      if (killSession(args.agent)) {
        return {
          content: [
            { type: "text", text: `Agent "${args.agent}" terminated.` },
          ],
        };
      }
      // Fall back to name lookup — check for ambiguity
      const matches = getAllSessions().filter(
        (s) => s.name.toLowerCase() === args.agent.toLowerCase(),
      );
      if (matches.length > 1) {
        const list = matches.map((s) => `  ${s.name} (id: ${s.id})`).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Multiple agents named "${args.agent}". Specify by ID:\n${list}`,
            },
          ],
          isError: true,
        };
      }
      if (matches.length === 1 && killSession(matches[0].id)) {
        return {
          content: [
            { type: "text", text: `Agent "${args.agent}" terminated.` },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `Agent "${args.agent}" not found.` }],
        isError: true,
      };
    },
  );

  return server;
}

// ── Transport ─────────────────────────────────────────────────────────

const mcpServer = createMcpServer();
const transports = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, body);
    return;
  }

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

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing MCP session" },
      id: null,
    }),
  );
}

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

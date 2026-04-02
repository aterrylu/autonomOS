#!/usr/bin/env node

/**
 * server:autonomos — MCP channel server for Claude Code
 *
 * Standalone script spawned by Claude Code as a subprocess.
 * Bridges MCP (stdio, to Claude Code) and WebSocket (to autonomOS gateway).
 *
 * Tools (mirrored from server MCP + gateway-specific):
 *   send(to, message)   — send to any URI: agent://name, broadcast://all
 *   list_agents()       — discover agents with their URIs
 *   create_agent(...)   — spawn a new dedicated agent
 *   kill_agent(agent)   — terminate an agent by name or ID
 *
 * Environment variables (set by autonomOS at spawn time):
 *   AUTONOMOS_SERVER_URL  — WebSocket URL
 *   AUTONOMOS_SESSION_ID  — this agent's autonomOS session ID
 *   AUTONOMOS_TOKEN       — auth token (optional)
 */

import type {
  AgentInfo,
  GatewayMessage,
  GatewayWsMessage,
} from "@autonomos/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Tool definitions are shared with the HTTP MCP server.
// Import paths use relative since this runs as a standalone subprocess.
// At build time, esbuild resolves these from the same package.
import { ALL_TOOLS, MCP_INSTRUCTIONS, MCP_SERVER_INFO } from "../mcp/tools.js";

const SESSION_ID = process.env.AUTONOMOS_SESSION_ID;
const SERVER_URL = process.env.AUTONOMOS_SERVER_URL;
const AUTH_TOKEN = process.env.AUTONOMOS_TOKEN;

if (!SESSION_ID || !SERVER_URL) {
  process.stderr.write(
    "autonomos-channel: AUTONOMOS_SESSION_ID and AUTONOMOS_SERVER_URL required\n",
  );
  process.exit(1);
}

// ── WebSocket connection to autonomOS server ──────────────────────

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

// Pending requests waiting for gateway response
const pendingRequests = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function connectToServer(): void {
  try {
    const url = AUTH_TOKEN
      ? `${SERVER_URL}?token=${encodeURIComponent(AUTH_TOKEN)}`
      : SERVER_URL!;
    ws = new WebSocket(url);
  } catch (err) {
    process.stderr.write(
      `autonomos-channel: WebSocket connect failed: ${err}\n`,
    );
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    const msg: GatewayWsMessage = {
      type: "register",
      sessionId: SESSION_ID!,
    };
    ws?.send(JSON.stringify(msg));
    process.stderr.write("autonomos-channel: connected to gateway\n");
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString(),
      ) as GatewayWsMessage;
      handleServerMessage(msg);
    } catch (err) {
      process.stderr.write(`autonomos-channel: bad message: ${err}\n`);
    }
  });

  ws.addEventListener("close", () => {
    process.stderr.write("autonomos-channel: disconnected from gateway\n");
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", (err) => {
    process.stderr.write(`autonomos-channel: ws error: ${err}\n`);
  });
}

function scheduleReconnect(): void {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToServer();
  }, reconnectDelay);
}

function handleServerMessage(msg: GatewayWsMessage): void {
  switch (msg.type) {
    case "message": {
      deliverToClaudeCode(msg.payload);
      break;
    }
    case "list_agents_response": {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.requestId);
        pending.resolve(msg.agents);
      }
      break;
    }
    case "send_result": {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.requestId);
        pending.resolve(msg);
      }
      break;
    }
  }
}

/** Send a WS message and wait for a correlated response */
function requestGateway<T>(
  msg: GatewayWsMessage,
  requestId: string,
  timeoutMs: number,
  defaultOnTimeout: T,
): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve(defaultOnTimeout);
  }
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(defaultOnTimeout);
    }, timeoutMs);
    pendingRequests.set(requestId, {
      resolve: resolve as (result: unknown) => void,
      timer,
    });
    try {
      ws!.send(JSON.stringify(msg));
    } catch {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve(defaultOnTimeout);
    }
  });
}

// ── MCP Server ────────────────────────────────────────────────────

const mcp = new Server(
  { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: MCP_INSTRUCTIONS,
  },
);

// ── Tool handlers ─────────────────────────────────────────────────
// Uses shared tool definitions from mcp/tools.ts.
// Handlers route through the gateway WebSocket for send/list_agents,
// and through the server's HTTP API for create_agent/kill_agent.

const SERVER_BASE = (() => {
  // Derive HTTP base URL from the WebSocket URL
  const wsUrl = SERVER_URL!;
  return wsUrl
    .replace("ws://", "http://")
    .replace("wss://", "https://")
    .replace(/\/ws\/gateway$/, "");
})();

/** MCP tool result shape (index signature required by MCP SDK) */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Build auth headers for server API calls */
function authHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  return headers;
}

/** Fetch from the autonomOS server API and return an MCP tool result */
async function serverFetch(
  path: string,
  init?: RequestInit,
): Promise<ToolResult> {
  const res = await fetch(`${SERVER_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(init?.body ? "application/json" : undefined),
      ...(init?.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      content: [{ type: "text", text: `Failed: ${text}` }],
      isError: true,
    };
  }
  const data = await res.json();
  const pretty =
    typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
  return { content: [{ type: "text", text: pretty }] };
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "send": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true,
        };
      }
      const { to, message } = args as { to: string; message: string };
      const requestId = crypto.randomUUID();
      const wsMsg: GatewayWsMessage = {
        type: "send",
        to,
        message,
        requestId,
      };

      // requestGateway sends the message and waits for a correlated response
      const result = await requestGateway<{
        success: boolean;
        error?: string;
      }>(wsMsg, requestId, 2000, {
        success: false,
        error: "Gateway did not confirm delivery (timeout)",
      });

      if (!result.success) {
        return {
          content: [{ type: "text", text: result.error ?? "Send failed" }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Sent to ${to}` }] };
    }

    case "list_agents": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true,
        };
      }
      const requestId = crypto.randomUUID();
      const wsMsg: GatewayWsMessage = {
        type: "list_agents_request",
        requestId,
      };
      const agents = await requestGateway<AgentInfo[]>(
        wsMsg,
        requestId,
        5000,
        [],
      );

      if (agents.length === 0) {
        return {
          content: [
            { type: "text", text: "No active agents (or request timed out)." },
          ],
        };
      }
      const lines = agents.map((a) => `${a.name} (${a.uri}) — ${a.status}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "create_agent": {
      // Route through the server's HTTP API — the channel server can't
      // call createSession() directly since it's a separate process.
      const {
        workingDirectory,
        name: agentName,
        systemPrompt,
        prompt,
        resumeSessionId,
        autonomousMode,
        template,
        manager,
        project,
      } = args as {
        workingDirectory: string;
        name?: string;
        systemPrompt?: string;
        prompt?: string;
        resumeSessionId?: string;
        autonomousMode?: boolean;
        template?: string;
        manager?: string;
        project?: string;
      };

      try {
        return await serverFetch("/api/sessions", {
          method: "POST",
          body: JSON.stringify({
            workingDirectory,
            name: agentName,
            prompt,
            resumeSessionId,
            autonomousMode: autonomousMode ?? true,
            appendSystemPrompt: systemPrompt,
            template,
            manager,
            project,
          }),
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create agent: ${err instanceof Error ? err.message : err}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "kill_agent": {
      const { agent } = args as { agent: string };
      try {
        const result = await serverFetch(
          `/api/sessions/${encodeURIComponent(agent)}`,
          { method: "DELETE" },
        );
        if (result.isError) return result;
        return {
          content: [{ type: "text", text: `Agent "${agent}" terminated.` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to kill agent: ${err instanceof Error ? err.message : err}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_manager": {
      const { agent, manager } = args as { agent: string; manager?: string };
      return serverFetch("/api/org/manager", {
        method: "PUT",
        body: JSON.stringify({ agent, manager: manager ?? null }),
      });
    }

    case "get_org_chart": {
      return serverFetch("/api/org");
    }

    case "create_template": {
      return serverFetch("/api/templates", {
        method: "POST",
        body: JSON.stringify(args),
      });
    }

    case "list_templates": {
      return serverFetch("/api/templates");
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Channel notification delivery ─────────────────────────────────

function deliverToClaudeCode(msg: GatewayMessage): void {
  // Prepend sender info so the terminal display shows who sent it
  const content = `[${msg.userName} → you via ${msg.fromUri}]\n${msg.text}`;

  mcp
    .notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          from: msg.userName,
          from_uri: msg.fromUri,
          ts: new Date(msg.timestamp).toISOString(),
        },
      },
    })
    .catch((err) => {
      process.stderr.write(
        `autonomos-channel: failed to deliver notification: ${err}\n`,
      );
    });
}

// ── Startup ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  connectToServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write(`autonomos-channel: started (session=${SESSION_ID})\n`);
}

main().catch((err) => {
  process.stderr.write(`autonomos-channel: fatal: ${err}\n`);
  process.exit(1);
});

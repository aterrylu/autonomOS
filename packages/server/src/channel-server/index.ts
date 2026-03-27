#!/usr/bin/env node

/**
 * server:autonomos — MCP channel server for Claude Code
 *
 * Standalone script spawned by Claude Code as a subprocess.
 * Bridges MCP (stdio, to Claude Code) and WebSocket (to autonomOS gateway).
 *
 * Tools:
 *   send(to, message) — send to any URI: agent://name, discord://guild/channel, broadcast://all
 *   list_agents()     — discover agents with their URIs
 *
 * Environment variables (set by autonomOS at spawn time):
 *   AUTONOMOS_SERVER_URL  — WebSocket URL, e.g. "ws://localhost:3100/ws/gateway"
 *   AUTONOMOS_SESSION_ID  — this agent's autonomOS session ID
 *   AUTONOMOS_TOKEN       — auth token (optional)
 */

import type { GatewayMessage, GatewayWsMessage } from "@autonomos/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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

// Pending list_agents requests
const pendingListAgents = new Map<
  string,
  {
    resolve: (
      agents: Array<{
        sessionId: string;
        name: string;
        uri: string;
        status: string;
      }>,
    ) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// Pending send results (for error feedback)
const pendingSends = new Map<
  string,
  {
    resolve: (result: { success: boolean; error?: string }) => void;
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
      const pending = pendingListAgents.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingListAgents.delete(msg.requestId);
        pending.resolve(msg.agents);
      }
      break;
    }
    case "send_result": {
      // Match any pending send by iterating (only one should be pending at a time)
      for (const [id, pending] of pendingSends) {
        clearTimeout(pending.timer);
        pendingSends.delete(id);
        pending.resolve(msg);
        break;
      }
      break;
    }
  }
}

// ── MCP Server ────────────────────────────────────────────────────

const mcp = new Server(
  { name: "autonomos", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "You are connected to the autonomOS gateway.",
      'Messages arrive as <channel source="autonomos" ...> events.',
      "",
      "Each message has:",
      "- from: the sender's name",
      "- from_uri: the sender's address — use this with the send tool to respond",
      "",
      'To respond to a message: send(to: "<from_uri from the message>", message: "your reply")',
      'To message an agent: send(to: "agent://agent-name", message: "hello")',
      'To broadcast to all agents: send(to: "broadcast://all", message: "announcement")',
      "",
      "Use list_agents to discover available agents and their URIs.",
    ].join("\n"),
  },
);

// ── Tool handlers ─────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send",
      description:
        "Send a message to any destination — agents, platform channels, or broadcast. Use the from_uri from incoming messages to respond.",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: {
            type: "string",
            description:
              'Destination URI (e.g. "agent://name", "discord://guild/channel", "broadcast://all")',
          },
          message: { type: "string", description: "Your message" },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "list_agents",
      description: "List all active agents with their names, URIs, and status",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return {
      content: [{ type: "text", text: "Not connected to gateway" }],
      isError: true,
    };
  }

  switch (name) {
    case "send": {
      const { to, message } = args as { to: string; message: string };
      const wsMsg: GatewayWsMessage = { type: "send", to, message };
      try {
        ws.send(JSON.stringify(wsMsg));
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Failed to send: gateway connection lost",
            },
          ],
          isError: true,
        };
      }

      // Wait briefly for send_result (error feedback from gateway)
      const result = await new Promise<{
        success: boolean;
        error?: string;
      }>((resolve) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pendingSends.delete(id);
          resolve({ success: true }); // assume success on timeout
        }, 2000);
        pendingSends.set(id, { resolve, timer });
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
      const requestId = crypto.randomUUID();
      const agents = await new Promise<
        Array<{
          sessionId: string;
          name: string;
          uri: string;
          status: string;
        }>
      >((resolve) => {
        const timer = setTimeout(() => {
          pendingListAgents.delete(requestId);
          resolve([]);
        }, 5000);
        pendingListAgents.set(requestId, { resolve, timer });
        const msg: GatewayWsMessage = {
          type: "list_agents_request",
          requestId,
        };
        ws!.send(JSON.stringify(msg));
      });

      if (agents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No active agents (or request timed out).",
            },
          ],
        };
      }
      const lines = agents.map((a) => `${a.name} (${a.uri}) — ${a.status}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Channel notification delivery ─────────────────────────────────

function deliverToClaudeCode(msg: GatewayMessage): void {
  mcp
    .notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.text,
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

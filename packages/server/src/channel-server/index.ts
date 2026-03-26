#!/usr/bin/env node

/**
 * server:autonomos — MCP channel server for Claude Code
 *
 * This is a standalone script spawned by Claude Code as a subprocess.
 * It bridges two connections:
 *   1. MCP over stdio (to Claude Code) — pushes <channel> events, exposes reply tools
 *   2. WebSocket (to autonomOS server) — receives messages to deliver, sends replies back
 *
 * Environment variables (set by autonomOS server at spawn time):
 *   AUTONOMOS_SERVER_URL  — WebSocket URL, e.g. "ws://localhost:3100/ws/gateway/SESSION_ID"
 *   AUTONOMOS_SESSION_ID  — this CC session's autonomOS ID
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

// Track the last inbound message source for reply routing
let lastInboundFrom: { platform: string; chatId: string } | null = null;

// Pending list_agents requests waiting for server response
const pendingListAgents = new Map<
  string,
  {
    resolve: (
      agents: Array<{ sessionId: string; name: string; status: string }>,
    ) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function connectToServer(): void {
  try {
    // Append auth token as query param if configured
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
    // Register this session with the gateway
    const msg: GatewayWsMessage = { type: "register", sessionId: SESSION_ID! };
    ws?.send(JSON.stringify(msg));
    process.stderr.write(`autonomos-channel: connected to gateway\n`);
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
      // Inbound platform message — deliver to Claude via MCP channel notification
      lastInboundFrom = {
        platform: msg.payload.platform,
        chatId: msg.payload.chatId,
      };
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
  }
}

// ── MCP Server ────────────────────────────────────────────────────
// Uses low-level Server class to declare experimental claude/channel capability

const mcp = new Server(
  { name: "autonomos", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Messages from external platforms (Discord, Telegram, Slack) and other autonomOS sessions arrive as <channel source="autonomos" ...> events.',
      "Use the reply tool to respond — pass the chat_id from the channel tag.",
      "Use send_to_agent to message another CC session by its session ID.",
      "Use list_agents to discover active sessions.",
    ].join(" "),
  },
);

// ── Tool handlers ─────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Reply to the platform that sent the last channel message (Discord, Telegram, Slack, or dashboard)",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "The chat_id from the inbound <channel> tag",
          },
          text: { type: "string", description: "The reply text" },
          reply_to: {
            type: "string",
            description: "Platform message ID to thread under (optional)",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "send_to_agent",
      description:
        "Send a message to another Claude Code session by name or ID",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: {
            type: "string",
            description:
              "Target session name or ID (use list_agents to discover)",
          },
          content: { type: "string", description: "Message to send" },
        },
        required: ["session_id", "content"],
      },
    },
    {
      name: "list_agents",
      description: "List all active autonomOS sessions",
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
    case "reply": {
      const { chat_id, text, reply_to } = args as {
        chat_id: string;
        text: string;
        reply_to?: string;
      };
      if (!lastInboundFrom) {
        return {
          content: [
            {
              type: "text",
              text: "Cannot determine target platform — no inbound message received yet.",
            },
          ],
          isError: true,
        };
      }
      const platform = lastInboundFrom.platform;
      const msg: GatewayWsMessage = {
        type: "reply",
        payload: {
          platform: platform as "discord" | "telegram" | "slack",
          chatId: chat_id,
          text,
          replyTo: reply_to,
        },
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        return {
          content: [
            { type: "text", text: "Failed to send: gateway connection lost" },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: "Reply sent." }] };
    }

    case "send_to_agent": {
      const { session_id, content } = args as {
        session_id: string;
        content: string;
      };
      const msg: GatewayWsMessage = {
        type: "send_to_agent",
        targetSessionId: session_id,
        content,
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        return {
          content: [
            { type: "text", text: "Failed to send: gateway connection lost" },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `Message sent to session ${session_id}` },
        ],
      };
    }

    case "list_agents": {
      const requestId = crypto.randomUUID();
      const agents = await new Promise<
        Array<{ sessionId: string; name: string; status: string }>
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
              text: "No active sessions (or request timed out).",
            },
          ],
        };
      }
      const lines = agents.map(
        (a) => `${a.name} (${a.sessionId}) — ${a.status}`,
      );
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
          platform: msg.platform,
          chat_id: msg.chatId,
          user: msg.userName,
          message_id: msg.platformMessageId,
          ts: new Date(msg.timestamp).toISOString(),
          ...(msg.replyTo && { reply_to: msg.replyTo }),
          ...(msg.threadId && { thread_id: msg.threadId }),
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
  // Connect to autonomOS gateway
  connectToServer();

  // Connect MCP over stdio (Claude Code spawns us as a subprocess)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write(`autonomos-channel: started (session=${SESSION_ID})\n`);
}

main().catch((err) => {
  process.stderr.write(`autonomos-channel: fatal: ${err}\n`);
  process.exit(1);
});

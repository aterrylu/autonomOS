#!/usr/bin/env node

// packages/server/src/channel-server/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
var SESSION_ID = process.env.AUTONOMOS_SESSION_ID;
var SERVER_URL = process.env.AUTONOMOS_SERVER_URL;
if (!SESSION_ID || !SERVER_URL) {
  process.stderr.write(
    "autonomos-channel: AUTONOMOS_SESSION_ID and AUTONOMOS_SERVER_URL required\n"
  );
  process.exit(1);
}
var ws = null;
var reconnectDelay = 1e3;
var MAX_RECONNECT_DELAY = 3e4;
var lastInboundFrom = null;
var pendingListAgents = /* @__PURE__ */ new Map();
function connectToServer() {
  try {
    ws = new WebSocket(SERVER_URL);
  } catch (err) {
    process.stderr.write(`autonomos-channel: WebSocket connect failed: ${err}
`);
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    reconnectDelay = 1e3;
    const msg = { type: "register", sessionId: SESSION_ID };
    ws?.send(JSON.stringify(msg));
    process.stderr.write(`autonomos-channel: connected to gateway
`);
  });
  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString()
      );
      handleServerMessage(msg);
    } catch (err) {
      process.stderr.write(`autonomos-channel: bad message: ${err}
`);
    }
  });
  ws.addEventListener("close", () => {
    process.stderr.write("autonomos-channel: disconnected from gateway\n");
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener("error", (err) => {
    process.stderr.write(`autonomos-channel: ws error: ${err}
`);
  });
}
function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToServer();
  }, reconnectDelay);
}
function handleServerMessage(msg) {
  switch (msg.type) {
    case "message": {
      lastInboundFrom = {
        platform: msg.payload.platform,
        chatId: msg.payload.chatId
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
var mcp = new Server(
  { name: "autonomos", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {}
    },
    instructions: [
      'Messages from external platforms (Discord, Telegram, Slack) and other autonomOS sessions arrive as <channel source="autonomos" ...> events.',
      "Use the reply tool to respond \u2014 pass the chat_id from the channel tag.",
      "Use send_to_agent to message another CC session by its session ID.",
      "Use list_agents to discover active sessions."
    ].join(" ")
  }
);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Reply to the platform that sent the last channel message (Discord, Telegram, Slack, or dashboard)",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "The chat_id from the inbound <channel> tag"
          },
          text: { type: "string", description: "The reply text" },
          reply_to: {
            type: "string",
            description: "Platform message ID to thread under (optional)"
          }
        },
        required: ["chat_id", "text"]
      }
    },
    {
      name: "send_to_agent",
      description: "Send a message to another Claude Code session by session ID",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Target session's autonomOS ID"
          },
          content: { type: "string", description: "Message to send" }
        },
        required: ["session_id", "content"]
      }
    },
    {
      name: "list_agents",
      description: "List all active autonomOS sessions",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { content: [{ type: "text", text: "Not connected to gateway" }], isError: true };
  }
  switch (name) {
    case "reply": {
      const { chat_id, text, reply_to } = args;
      if (!lastInboundFrom) {
        return {
          content: [{ type: "text", text: "Cannot determine target platform \u2014 no inbound message received yet." }],
          isError: true
        };
      }
      const platform = lastInboundFrom.platform;
      const msg = {
        type: "reply",
        payload: {
          platform,
          chatId: chat_id,
          text,
          replyTo: reply_to
        }
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        return { content: [{ type: "text", text: "Failed to send: gateway connection lost" }], isError: true };
      }
      return { content: [{ type: "text", text: "Reply sent." }] };
    }
    case "send_to_agent": {
      const { session_id, content } = args;
      const msg = {
        type: "send_to_agent",
        targetSessionId: session_id,
        content
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        return { content: [{ type: "text", text: "Failed to send: gateway connection lost" }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Message sent to session ${session_id}` }]
      };
    }
    case "list_agents": {
      const requestId = crypto.randomUUID();
      const agents = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingListAgents.delete(requestId);
          resolve([]);
        }, 5e3);
        pendingListAgents.set(requestId, { resolve, timer });
        const msg = { type: "list_agents_request", requestId };
        ws.send(JSON.stringify(msg));
      });
      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No active sessions (or request timed out)." }] };
      }
      const lines = agents.map((a) => `${a.name} (${a.sessionId}) \u2014 ${a.status}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});
function deliverToClaudeCode(msg) {
  mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: msg.text,
      meta: {
        platform: msg.platform,
        chat_id: msg.chatId,
        user: msg.userName,
        message_id: msg.platformMessageId,
        ts: new Date(msg.timestamp).toISOString(),
        ...msg.replyTo && { reply_to: msg.replyTo },
        ...msg.threadId && { thread_id: msg.threadId }
      }
    }
  }).catch((err) => {
    process.stderr.write(
      `autonomos-channel: failed to deliver notification: ${err}
`
    );
  });
}
async function main() {
  connectToServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write(
    `autonomos-channel: started (session=${SESSION_ID})
`
  );
}
main().catch((err) => {
  process.stderr.write(`autonomos-channel: fatal: ${err}
`);
  process.exit(1);
});

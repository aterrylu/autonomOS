#!/usr/bin/env node

// packages/server/src/channel-server/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
var SESSION_ID = process.env.AUTONOMOS_SESSION_ID;
var SERVER_URL = process.env.AUTONOMOS_SERVER_URL;
var AUTH_TOKEN = process.env.AUTONOMOS_TOKEN;
if (!SESSION_ID || !SERVER_URL) {
  process.stderr.write(
    "autonomos-channel: AUTONOMOS_SESSION_ID and AUTONOMOS_SERVER_URL required\n"
  );
  process.exit(1);
}
var ws = null;
var reconnectDelay = 1e3;
var MAX_RECONNECT_DELAY = 3e4;
var pendingListAgents = /* @__PURE__ */ new Map();
var pendingSends = /* @__PURE__ */ new Map();
function connectToServer() {
  try {
    const url = AUTH_TOKEN ? `${SERVER_URL}?token=${encodeURIComponent(AUTH_TOKEN)}` : SERVER_URL;
    ws = new WebSocket(url);
  } catch (err) {
    process.stderr.write(
      `autonomos-channel: WebSocket connect failed: ${err}
`
    );
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    reconnectDelay = 1e3;
    const msg = {
      type: "register",
      sessionId: SESSION_ID
    };
    ws?.send(JSON.stringify(msg));
    process.stderr.write("autonomos-channel: connected to gateway\n");
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
      const pending = pendingSends.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingSends.delete(msg.requestId);
        pending.resolve(msg);
      }
      break;
    }
  }
}
var mcp = new Server(
  { name: "autonomos", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {}
    },
    instructions: [
      "You are connected to the autonomOS gateway.",
      'Messages arrive as <channel source="autonomos" ...> events.',
      "",
      "Each message has:",
      "- from: the sender's name",
      "- from_uri: the sender's address \u2014 use this with the send tool to respond",
      "",
      'To respond to a message: send(to: "<from_uri from the message>", message: "your reply")',
      'To message an agent: send(to: "agent://agent-name", message: "hello")',
      'To broadcast to all agents: send(to: "broadcast://all", message: "announcement")',
      "",
      "Use list_agents to discover available agents and their URIs."
    ].join("\n")
  }
);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send",
      description: "Send a message to any destination \u2014 agents, platform channels, or broadcast. Use the from_uri from incoming messages to respond.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: 'Destination URI (e.g. "agent://name", "discord://guild/channel", "broadcast://all")'
          },
          message: { type: "string", description: "Your message" }
        },
        required: ["to", "message"]
      }
    },
    {
      name: "list_agents",
      description: "List all active agents with their names, URIs, and status",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return {
      content: [{ type: "text", text: "Not connected to gateway" }],
      isError: true
    };
  }
  switch (name) {
    case "send": {
      const { to, message } = args;
      const requestId = crypto.randomUUID();
      const wsMsg = { type: "send", to, message, requestId };
      try {
        ws.send(JSON.stringify(wsMsg));
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Failed to send: gateway connection lost"
            }
          ],
          isError: true
        };
      }
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSends.delete(requestId);
          resolve({ success: true });
        }, 2e3);
        pendingSends.set(requestId, { resolve, timer });
      });
      if (!result.success) {
        return {
          content: [{ type: "text", text: result.error ?? "Send failed" }],
          isError: true
        };
      }
      return { content: [{ type: "text", text: `Sent to ${to}` }] };
    }
    case "list_agents": {
      const requestId = crypto.randomUUID();
      const agents = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingListAgents.delete(requestId);
          resolve([]);
        }, 5e3);
        pendingListAgents.set(requestId, { resolve, timer });
        const msg = {
          type: "list_agents_request",
          requestId
        };
        ws.send(JSON.stringify(msg));
      });
      if (agents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No active agents (or request timed out)."
            }
          ]
        };
      }
      const lines = agents.map((a) => `${a.name} (${a.uri}) \u2014 ${a.status}`);
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
        from: msg.userName,
        from_uri: msg.fromUri,
        ts: new Date(msg.timestamp).toISOString()
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
  process.stderr.write(`autonomos-channel: started (session=${SESSION_ID})
`);
}
main().catch((err) => {
  process.stderr.write(`autonomos-channel: fatal: ${err}
`);
  process.exit(1);
});

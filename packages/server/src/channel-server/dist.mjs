#!/usr/bin/env node

// packages/server/src/channel-server/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// packages/server/src/mcp/tools.ts
var TOOL_CREATE_AGENT = {
  name: "create_agent",
  description: "Create a new agent \u2014 a dedicated Claude Code session with a name, context, and optional task.",
  inputSchema: {
    type: "object",
    properties: {
      workingDirectory: {
        type: "string",
        description: "Absolute path to the working directory (~ allowed)"
      },
      name: {
        type: "string",
        description: "Display name for the agent (shown in dashboard and list_agents)"
      },
      systemPrompt: {
        type: "string",
        description: "Instructions appended to the default system prompt. Defines the agent's role. Keeps CLAUDE.md and CC defaults."
      },
      prompt: {
        type: "string",
        description: "Initial task or message to send to the agent \u2014 this is what the agent starts working on"
      },
      resumeSessionId: {
        type: "string",
        description: "Claude Code session ID to resume (for reconnecting to an existing agent)"
      },
      autonomousMode: {
        type: "boolean",
        description: "Skip permission prompts (default: true)",
        default: true
      }
    },
    required: ["workingDirectory"]
  }
};
var TOOL_LIST_AGENTS = {
  name: "list_agents",
  description: "List all active agents with their names, URIs, status, and working directories",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var TOOL_KILL_AGENT = {
  name: "kill_agent",
  description: "Terminate an active agent by name or session ID",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent name or session ID to terminate"
      }
    },
    required: ["agent"]
  }
};
var TOOL_SEND = {
  name: "send",
  description: "Send a message to any destination \u2014 agents, platform channels, or broadcast. Use the from_uri from incoming messages to respond.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: 'Destination URI (e.g. "agent://name", "discord://guild/channel", "broadcast://all")'
      },
      message: {
        type: "string",
        description: "Your message"
      }
    },
    required: ["to", "message"]
  }
};
var ALL_TOOLS = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
  TOOL_SEND
];
var MCP_SERVER_INFO = {
  name: "autonomos",
  version: "0.3.0"
};
var MCP_INSTRUCTIONS = [
  "You are running inside autonomOS \u2014 an agent orchestration platform.",
  "",
  "Available tools:",
  "- send(to, message): Send messages to agents or platforms via URI",
  "  - agent://name \u2014 message another agent (use list_agents to discover names)",
  "  - broadcast://all \u2014 message all agents",
  "- list_agents(): See all active agents with their URIs",
  "- create_agent(): Spawn a new dedicated agent with a task",
  "- kill_agent(): Terminate an agent",
  "",
  "Messages from other agents and platforms arrive as <channel> events.",
  "Each has from (sender name) and from_uri (address to respond to).",
  'To respond: send(to: "<from_uri>", message: "your reply")'
].join("\n");

// packages/server/src/channel-server/index.ts
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
var pendingRequests = /* @__PURE__ */ new Map();
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
function requestGateway(msg, requestId, timeoutMs, defaultOnTimeout) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve(defaultOnTimeout);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(defaultOnTimeout);
    }, timeoutMs);
    pendingRequests.set(requestId, {
      resolve,
      timer
    });
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve(defaultOnTimeout);
    }
  });
}
var mcp = new Server(
  { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {}
    },
    instructions: MCP_INSTRUCTIONS
  }
);
var SERVER_BASE = (() => {
  const wsUrl = SERVER_URL;
  return wsUrl.replace("ws://", "http://").replace("wss://", "https://").replace(/\/ws\/gateway$/, "");
})();
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS
}));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case "send": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true
        };
      }
      const { to, message } = args;
      const requestId = crypto.randomUUID();
      const wsMsg = {
        type: "send",
        to,
        message,
        requestId
      };
      const result = await requestGateway(wsMsg, requestId, 2e3, {
        success: false,
        error: "Gateway did not confirm delivery (timeout)"
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
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true
        };
      }
      const requestId = crypto.randomUUID();
      const wsMsg = {
        type: "list_agents_request",
        requestId
      };
      const agents = await requestGateway(
        wsMsg,
        requestId,
        5e3,
        []
      );
      if (agents.length === 0) {
        return {
          content: [
            { type: "text", text: "No active agents (or request timed out)." }
          ]
        };
      }
      const lines = agents.map((a) => `${a.name} (${a.uri}) \u2014 ${a.status}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    case "create_agent": {
      const {
        workingDirectory,
        name: agentName,
        systemPrompt,
        prompt,
        resumeSessionId,
        autonomousMode
      } = args;
      try {
        const headers = {
          "Content-Type": "application/json"
        };
        if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
        const res = await fetch(`${SERVER_BASE}/api/sessions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            workingDirectory,
            name: agentName,
            prompt,
            resumeSessionId,
            autonomousMode: autonomousMode ?? true,
            appendSystemPrompt: systemPrompt
          })
        });
        if (!res.ok) {
          const text = await res.text();
          return {
            content: [
              { type: "text", text: `Failed to create agent: ${text}` }
            ],
            isError: true
          };
        }
        const session = await res.json();
        return {
          content: [{ type: "text", text: JSON.stringify(session, null, 2) }]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to create agent: ${err instanceof Error ? err.message : err}`
            }
          ],
          isError: true
        };
      }
    }
    case "kill_agent": {
      const { agent } = args;
      try {
        const headers = {};
        if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
        const res = await fetch(
          `${SERVER_BASE}/api/sessions/${encodeURIComponent(agent)}`,
          { method: "DELETE", headers }
        );
        if (!res.ok) {
          const text = await res.text();
          return {
            content: [{ type: "text", text: `Failed to kill agent: ${text}` }],
            isError: true
          };
        }
        return {
          content: [{ type: "text", text: `Agent "${agent}" terminated.` }]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to kill agent: ${err instanceof Error ? err.message : err}`
            }
          ],
          isError: true
        };
      }
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

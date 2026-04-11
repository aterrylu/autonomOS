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
      forkFrom: {
        type: "string",
        description: "Claude session ID to fork from \u2014 child inherits parent's conversation context. Mutually exclusive with resumeSessionId."
      },
      autonomousMode: {
        type: "boolean",
        description: "Skip permission prompts (default: true)",
        default: true
      },
      template: {
        type: "string",
        description: "Template name to base this agent on (e.g. 'team-lead', 'worker'). Templates define role, system prompt, and capabilities."
      },
      manager: {
        type: "string",
        description: "Manager agent name (e.g. 'TeamLead@autonomOS'). Sets the org chart relationship."
      },
      project: {
        type: "string",
        description: "Project scope (e.g. 'autonomOS', 'homelab'). Used in role@project naming."
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
var TOOL_SET_MANAGER = {
  name: "set_manager",
  description: "Set an agent's manager in the org chart. Both agents must be registered.",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent name (e.g. 'Dashboard@autonomOS')"
      },
      manager: {
        type: "string",
        description: "Manager agent name (e.g. 'TeamLead@autonomOS'). Use null or empty to remove manager."
      }
    },
    required: ["agent"]
  }
};
var TOOL_GET_ORG_CHART = {
  name: "get_org_chart",
  description: "Get the organization chart showing all agents and their hierarchy.",
  inputSchema: {
    type: "object",
    properties: {
      includeExited: {
        type: "boolean",
        description: "Include exited agents in the chart (default: false, only running agents shown)"
      }
    }
  }
};
var TOOL_LIST_TEMPLATES = {
  name: "list_templates",
  description: "List available agent templates (blueprints for creating agents with predefined roles).",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var TOOL_CREATE_TEMPLATE = {
  name: "create_template",
  description: "Create a reusable agent template (blueprint) that defines a role, system prompt, and capabilities. Saved to ~/.autonomos/templates/.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Template name (lowercase, hyphens, e.g. 'feature-worker', 'code-reviewer'). Used as the filename."
      },
      role: {
        type: "string",
        description: "Human-readable role name (e.g. 'Feature Worker', 'Code Reviewer')"
      },
      description: {
        type: "string",
        description: "Short description of what this template is for"
      },
      systemPrompt: {
        type: "string",
        description: "System prompt appended to the agent's CC session. Defines the agent's behavior and responsibilities."
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "Capabilities to grant: 'send', 'list_agents', 'create_agent', 'kill_agent'. Defaults to all."
      },
      autonomousMode: {
        type: "boolean",
        description: "Skip permission prompts (default: true)"
      },
      model: {
        type: "string",
        description: "Model override for litellm routing (e.g. 'opus', 'sonnet', 'haiku'). Omit for CC default."
      }
    },
    required: ["name", "role", "description", "systemPrompt"]
  }
};
var ALL_TOOLS = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
  TOOL_SEND,
  TOOL_SET_MANAGER,
  TOOL_GET_ORG_CHART,
  TOOL_LIST_TEMPLATES,
  TOOL_CREATE_TEMPLATE
];
var MCP_SERVER_INFO = {
  name: "autonomos",
  version: "0.3.0"
};
var MCP_INSTRUCTIONS = [
  "You are running inside autonomOS \u2014 an agent orchestration platform.",
  "",
  "Available tools:",
  "- send(to, message): Send messages via URI (agent://name, broadcast://all)",
  "- list_agents(): Discover active agents and their URIs",
  "- create_agent(): Spawn a new dedicated agent",
  "- kill_agent(): Terminate an agent",
  "- set_manager(): Configure org chart relationships",
  "- get_org_chart(): View the organization hierarchy",
  "- list_templates(): Browse available agent templates",
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
    } catch {
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
function authHeaders(contentType) {
  const headers = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  return headers;
}
async function serverFetch(path, init) {
  const res = await fetch(`${SERVER_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(init?.body ? "application/json" : void 0),
      ...init?.headers
    }
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      content: [{ type: "text", text: `Failed: ${text}` }],
      isError: true
    };
  }
  const data = await res.json();
  const pretty = typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
  return { content: [{ type: "text", text: pretty }] };
}
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
        forkFrom,
        autonomousMode,
        template,
        manager,
        project
      } = args;
      const effectiveManager = manager ?? process.env.AUTONOMOS_AGENT_NAME;
      if (!manager && effectiveManager) {
        process.stderr.write(
          `autonomos-channel: auto-setting manager to "${effectiveManager}"
`
        );
      }
      try {
        return await serverFetch("/api/sessions", {
          method: "POST",
          body: JSON.stringify({
            workingDirectory,
            name: agentName,
            prompt,
            resumeSessionId,
            forkFrom,
            autonomousMode: autonomousMode ?? true,
            appendSystemPrompt: systemPrompt,
            template,
            manager: effectiveManager,
            project
          })
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `autonomos-channel: create_agent failed: ${msg}
`
        );
        return {
          content: [{ type: "text", text: `Failed to create agent: ${msg}` }],
          isError: true
        };
      }
    }
    case "kill_agent": {
      const { agent } = args;
      try {
        const result = await serverFetch(
          `/api/sessions/${encodeURIComponent(agent)}`,
          { method: "DELETE" }
        );
        if (result.isError) return result;
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
    case "set_manager": {
      const { agent, manager } = args;
      return serverFetch("/api/org/manager", {
        method: "PUT",
        body: JSON.stringify({ agent, manager: manager ?? null })
      });
    }
    case "get_org_chart": {
      const { includeExited } = args;
      const qs = includeExited ? "?includeExited=true" : "";
      return serverFetch(`/api/org${qs}`);
    }
    case "create_template": {
      return serverFetch("/api/templates", {
        method: "POST",
        body: JSON.stringify(args)
      });
    }
    case "list_templates": {
      return serverFetch("/api/templates");
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});
function deliverToClaudeCode(msg) {
  const content = `[${msg.userName} \u2192 you via ${msg.fromUri}]
${msg.text}`;
  mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content,
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

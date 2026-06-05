#!/usr/bin/env node

// packages/server/src/channel-server/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

// packages/server/src/mcp/tools.ts
var DEFAULT_CAPABILITIES = [
  "send",
  "list_agents",
  "create_agent",
  "kill_agent",
  "self_exit"
];
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
      },
      name: {
        type: "string",
        description: "Alias for 'agent' \u2014 agent name or session ID to terminate"
      }
    }
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
      name: {
        type: "string",
        description: "Alias for 'agent' \u2014 agent name (e.g. 'Dashboard@autonomOS')"
      },
      manager: {
        type: "string",
        description: "Manager agent name (e.g. 'TeamLead@autonomOS'). Use null or empty to remove manager."
      }
    }
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
        description: `Capabilities to grant: ${DEFAULT_CAPABILITIES.map((c) => `'${c}'`).join(", ")}. Defaults to all.`
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
var TOOL_SELF_EXIT = {
  name: "self_exit",
  description: "Terminate your own session. Use when your work is complete and you want to exit cleanly.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var TOOL_CREATE_SCHEDULE = {
  name: "create_schedule",
  description: "Create a new scheduled task that runs on a cron schedule or once at a specific time.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name (lowercase, hyphens, e.g. 'daily-github-summary')"
      },
      schedule: {
        type: "string",
        description: 'Cron expression (e.g. "0 9 * * 1-5") or one-time (e.g. "once:2026-04-15T09:00")'
      },
      target: {
        type: "string",
        description: '"isolated" (headless claude -p) or "agent:<name>" (send to running agent)'
      },
      prompt: {
        type: "string",
        description: "The prompt/task to execute on each run"
      },
      workingDirectory: {
        type: "string",
        description: "Working directory for isolated execution (~ allowed)"
      },
      description: {
        type: "string",
        description: "Human-readable description of what this schedule does"
      },
      timezone: {
        type: "string",
        description: "IANA timezone (e.g. 'America/Los_Angeles'). Defaults to server local."
      },
      template: {
        type: "string",
        description: "Template name for isolated mode execution"
      },
      autonomous: {
        type: "boolean",
        description: "Skip permission prompts in isolated mode (default: true)",
        default: true
      },
      overlapPolicy: {
        type: "string",
        description: '"skip" (default, skip if previous run active) or "allow" (run regardless)'
      },
      onComplete: {
        type: "string",
        description: "Gateway URI to send results to when run completes (isolated mode only)"
      },
      notify: {
        type: "string",
        description: '"always", "failure" (default), or "never" \u2014 when to send notifications'
      },
      enabled: {
        type: "boolean",
        description: "Whether the schedule is active (default: true)",
        default: true
      }
    },
    required: ["name", "schedule", "target", "prompt", "workingDirectory"]
  }
};
var TOOL_LIST_SCHEDULES = {
  name: "list_schedules",
  description: "List all scheduled tasks with their config and current state.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var TOOL_GET_SCHEDULE = {
  name: "get_schedule",
  description: "Get a schedule's full config, state, and recent run history.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name"
      }
    },
    required: ["name"]
  }
};
var TOOL_UPDATE_SCHEDULE = {
  name: "update_schedule",
  description: "Update a schedule's config (partial merge). State is preserved.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name to update"
      },
      schedule: { type: "string", description: "New cron expression" },
      target: { type: "string", description: "New target" },
      prompt: { type: "string", description: "New prompt" },
      workingDirectory: {
        type: "string",
        description: "New working directory"
      },
      description: { type: "string", description: "New description" },
      timezone: { type: "string", description: "New timezone" },
      template: { type: "string", description: "New template" },
      autonomous: { type: "boolean", description: "New autonomous mode" },
      overlapPolicy: { type: "string", description: "New overlap policy" },
      onComplete: { type: "string", description: "New onComplete URI" },
      notify: { type: "string", description: "New notify policy" },
      enabled: { type: "boolean", description: "Enable/disable" }
    },
    required: ["name"]
  }
};
var TOOL_DELETE_SCHEDULE = {
  name: "delete_schedule",
  description: "Delete a schedule. Run history is preserved for audit.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name to delete"
      }
    },
    required: ["name"]
  }
};
var TOOL_RUN_SCHEDULE = {
  name: "run_schedule",
  description: "Trigger a schedule immediately, ignoring cron timing. Respects overlap policy and concurrency limits.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name to trigger"
      }
    },
    required: ["name"]
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
  TOOL_CREATE_TEMPLATE,
  TOOL_SELF_EXIT,
  TOOL_CREATE_SCHEDULE,
  TOOL_LIST_SCHEDULES,
  TOOL_GET_SCHEDULE,
  TOOL_UPDATE_SCHEDULE,
  TOOL_DELETE_SCHEDULE,
  TOOL_RUN_SCHEDULE
];
var CAPABILITY_GATED_TOOLS = new Set(DEFAULT_CAPABILITIES);
function filterToolsByCapabilities(capabilities) {
  const allowed = new Set(capabilities);
  return ALL_TOOLS.filter((tool) => {
    return !CAPABILITY_GATED_TOOLS.has(tool.name) || allowed.has(tool.name);
  });
}
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
  "- create_template(): Create a reusable agent template",
  "- self_exit(): Terminate your own session when work is complete",
  "",
  "Schedule tools:",
  "- create_schedule(): Create a recurring or one-time scheduled task",
  "- list_schedules(): List all schedules with their state",
  "- get_schedule(): Get schedule details and recent run history",
  "- update_schedule(): Update a schedule's configuration",
  "- delete_schedule(): Remove a schedule",
  "- run_schedule(): Trigger a schedule immediately",
  "",
  "Messages from other agents and platforms arrive as <channel> events.",
  "Each has from (sender name) and from_uri (address to respond to).",
  'To respond: send(to: "<from_uri>", message: "your reply")'
].join("\n");

// packages/server/src/channel-server/index.ts
var SESSION_ID = process.env.AUTONOMOS_SESSION_ID;
var SERVER_URL = process.env.AUTONOMOS_SERVER_URL;
var AUTH_TOKEN = process.env.AUTONOMOS_TOKEN;
var CAPABILITIES = process.env.AUTONOMOS_CAPABILITIES ? process.env.AUTONOMOS_CAPABILITIES.split(",") : DEFAULT_CAPABILITIES;
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
var agentTools = filterToolsByCapabilities(CAPABILITIES);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: agentTools
}));
var capSet = new Set(CAPABILITIES);
var gatedTools = new Set(DEFAULT_CAPABILITIES);
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (gatedTools.has(name) && !capSet.has(name)) {
    return {
      content: [
        {
          type: "text",
          text: `Tool "${name}" is not available. Missing capability: "${name}".`
        }
      ],
      isError: true
    };
  }
  switch (name) {
    case "send": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true
        };
      }
      const { to, message } = args;
      if (!to || !message) {
        return {
          content: [
            {
              type: "text",
              text: `Missing required parameter(s). Usage: send(to: "agent://name", message: "your message")`
            }
          ],
          isError: true
        };
      }
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
        return await serverFetch("/api/agents", {
          method: "POST",
          body: JSON.stringify({
            workingDirectory,
            name: agentName,
            prompt,
            resumeAgentId: resumeSessionId,
            forkFromAgentId: forkFrom,
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
      const { agent, name: nameAlias } = args;
      const target = agent || nameAlias;
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `Missing parameter: provide 'agent' or 'name'. Usage: kill_agent(agent: "AgentName")`
            }
          ],
          isError: true
        };
      }
      try {
        const result = await serverFetch(
          `/api/agents/${encodeURIComponent(target)}/kill`,
          { method: "POST" }
        );
        if (result.isError) return result;
        return {
          content: [{ type: "text", text: `Agent "${target}" terminated.` }]
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
      const {
        agent,
        name: nameAlias,
        manager
      } = args;
      const setTarget = agent || nameAlias;
      if (!setTarget) {
        return {
          content: [
            {
              type: "text",
              text: `Missing parameter: provide 'agent' or 'name'. Usage: set_manager(agent: "AgentName", manager: "ManagerName")`
            }
          ],
          isError: true
        };
      }
      return serverFetch(
        `/api/agents/${encodeURIComponent(setTarget)}/manager`,
        {
          method: "POST",
          body: JSON.stringify({ manager: manager ?? null })
        }
      );
    }
    case "get_org_chart": {
      const { includeExited } = args;
      const qs = includeExited ? "?includeExited=true" : "";
      return serverFetch(`/api/agents/tree${qs}`);
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
    case "self_exit": {
      serverFetch(`/api/agents/${encodeURIComponent(SESSION_ID)}`, {
        method: "DELETE"
      }).catch((err) => {
        process.stderr.write(
          `autonomos-channel: self_exit failed: ${err instanceof Error ? err.message : err}
`
        );
      });
      return { content: [{ type: "text", text: "Exiting..." }] };
    }
    // ── Schedule tools (route through server HTTP API) ──────────
    case "create_schedule":
      return serverFetch("/api/schedules", {
        method: "POST",
        body: JSON.stringify(args)
      });
    case "list_schedules":
      return serverFetch("/api/schedules");
    case "get_schedule": {
      const { name: schedName } = args;
      return serverFetch(`/api/schedules/${encodeURIComponent(schedName)}`);
    }
    case "update_schedule": {
      const { name: schedName, ...schedPartial } = args;
      return serverFetch(`/api/schedules/${encodeURIComponent(schedName)}`, {
        method: "PUT",
        body: JSON.stringify(schedPartial)
      });
    }
    case "delete_schedule": {
      const { name: schedName } = args;
      return serverFetch(`/api/schedules/${encodeURIComponent(schedName)}`, {
        method: "DELETE"
      });
    }
    case "run_schedule": {
      const { name: schedName } = args;
      return serverFetch(
        `/api/schedules/${encodeURIComponent(schedName)}/run`,
        { method: "POST" }
      );
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

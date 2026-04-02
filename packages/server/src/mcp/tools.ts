/**
 * Shared MCP tool definitions for autonomOS.
 *
 * These tool schemas and descriptions are used by BOTH:
 * - The HTTP MCP server (external clients: Claude Desktop, CI, etc.)
 * - The channel MCP server (internal: autonomOS-spawned CC sessions)
 *
 * Tool handlers are NOT shared — the channel server routes via WebSocket
 * to the gateway, while the HTTP server calls session functions directly.
 * But the schemas and descriptions are identical.
 */

/** Tool definition shape matching MCP SDK's tool list format */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Tool Definitions ──────────────────────────────────────────────

export const TOOL_CREATE_AGENT: ToolDef = {
  name: "create_agent",
  description:
    "Create a new agent — a dedicated Claude Code session with a name, context, and optional task.",
  inputSchema: {
    type: "object",
    properties: {
      workingDirectory: {
        type: "string",
        description: "Absolute path to the working directory (~ allowed)",
      },
      name: {
        type: "string",
        description:
          "Display name for the agent (shown in dashboard and list_agents)",
      },
      systemPrompt: {
        type: "string",
        description:
          "Instructions appended to the default system prompt. Defines the agent's role. Keeps CLAUDE.md and CC defaults.",
      },
      prompt: {
        type: "string",
        description:
          "Initial task or message to send to the agent — this is what the agent starts working on",
      },
      resumeSessionId: {
        type: "string",
        description:
          "Claude Code session ID to resume (for reconnecting to an existing agent)",
      },
      autonomousMode: {
        type: "boolean",
        description: "Skip permission prompts (default: true)",
        default: true,
      },
      template: {
        type: "string",
        description:
          "Template name to base this agent on (e.g. 'team-lead', 'worker'). Templates define role, system prompt, and capabilities.",
      },
      manager: {
        type: "string",
        description:
          "Manager agent name (e.g. 'TeamLead@autonomOS'). Sets the org chart relationship.",
      },
      project: {
        type: "string",
        description:
          "Project scope (e.g. 'autonomOS', 'homelab'). Used in role@project naming.",
      },
    },
    required: ["workingDirectory"],
  },
};

export const TOOL_LIST_AGENTS: ToolDef = {
  name: "list_agents",
  description:
    "List all active agents with their names, URIs, status, and working directories",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const TOOL_KILL_AGENT: ToolDef = {
  name: "kill_agent",
  description: "Terminate an active agent by name or session ID",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent name or session ID to terminate",
      },
    },
    required: ["agent"],
  },
};

export const TOOL_SEND: ToolDef = {
  name: "send",
  description:
    "Send a message to any destination — agents, platform channels, or broadcast. Use the from_uri from incoming messages to respond.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          'Destination URI (e.g. "agent://name", "discord://guild/channel", "broadcast://all")',
      },
      message: {
        type: "string",
        description: "Your message",
      },
    },
    required: ["to", "message"],
  },
};

export const TOOL_SET_MANAGER: ToolDef = {
  name: "set_manager",
  description:
    "Set an agent's manager in the org chart. Both agents must be registered.",
  inputSchema: {
    type: "object",
    properties: {
      agent: {
        type: "string",
        description: "Agent name (e.g. 'Dashboard@autonomOS')",
      },
      manager: {
        type: "string",
        description:
          "Manager agent name (e.g. 'TeamLead@autonomOS'). Use null or empty to remove manager.",
      },
    },
    required: ["agent"],
  },
};

export const TOOL_GET_ORG_CHART: ToolDef = {
  name: "get_org_chart",
  description:
    "Get the organization chart showing all agents and their hierarchy.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const TOOL_LIST_TEMPLATES: ToolDef = {
  name: "list_templates",
  description:
    "List available agent templates (blueprints for creating agents with predefined roles).",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const TOOL_CREATE_TEMPLATE: ToolDef = {
  name: "create_template",
  description:
    "Create a reusable agent template (blueprint) that defines a role, system prompt, and capabilities. Saved to ~/.autonomos/templates/.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Template name (lowercase, hyphens, e.g. 'feature-worker', 'code-reviewer'). Used as the filename.",
      },
      role: {
        type: "string",
        description:
          "Human-readable role name (e.g. 'Feature Worker', 'Code Reviewer')",
      },
      description: {
        type: "string",
        description: "Short description of what this template is for",
      },
      systemPrompt: {
        type: "string",
        description:
          "System prompt appended to the agent's CC session. Defines the agent's behavior and responsibilities.",
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description:
          "Capabilities to grant: 'send', 'list_agents', 'create_agent', 'kill_agent'. Defaults to all.",
      },
      autonomousMode: {
        type: "boolean",
        description: "Skip permission prompts (default: true)",
      },
      model: {
        type: "string",
        description:
          "Model override for litellm routing (e.g. 'opus', 'sonnet', 'haiku'). Omit for CC default.",
      },
    },
    required: ["name", "role", "description", "systemPrompt"],
  },
};

/** All tools — used by both server and channel MCP */
export const ALL_TOOLS: ToolDef[] = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
  TOOL_SEND,
  TOOL_SET_MANAGER,
  TOOL_GET_ORG_CHART,
  TOOL_LIST_TEMPLATES,
  TOOL_CREATE_TEMPLATE,
];

/** Tools available without gateway connection (HTTP MCP for external clients) */
export const SERVER_TOOLS: ToolDef[] = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
  TOOL_SET_MANAGER,
  TOOL_GET_ORG_CHART,
  TOOL_LIST_TEMPLATES,
  TOOL_CREATE_TEMPLATE,
];

// ── Shared MCP metadata ──────────────────────────────────────────

export const MCP_SERVER_INFO = {
  name: "autonomos",
  version: "0.3.0",
} as const;

export const MCP_INSTRUCTIONS = [
  "You are running inside autonomOS — an agent orchestration platform.",
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
  'To respond: send(to: "<from_uri>", message: "your reply")',
].join("\n");

/** Instructions for external MCP clients (no channel/send capability) */
export const MCP_INSTRUCTIONS_EXTERNAL =
  "autonomOS orchestrator — create and manage agents across workspaces.";

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

/** All tools — used by both server and channel MCP */
export const ALL_TOOLS: ToolDef[] = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
  TOOL_SEND,
];

/** Tools available without gateway connection (HTTP MCP for external clients) */
export const SERVER_TOOLS: ToolDef[] = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
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
  "- send(to, message): Send messages to agents or platforms via URI",
  "  - agent://name — message another agent (use list_agents to discover names)",
  "  - broadcast://all — message all agents",
  "- list_agents(): See all active agents with their URIs",
  "- create_agent(): Spawn a new dedicated agent with a task",
  "- kill_agent(): Terminate an agent",
  "",
  "Messages from other agents and platforms arrive as <channel> events.",
  "Each has from (sender name) and from_uri (address to respond to).",
  'To respond: send(to: "<from_uri>", message: "your reply")',
].join("\n");

/** Instructions for external MCP clients (no channel/send capability) */
export const MCP_INSTRUCTIONS_EXTERNAL =
  "autonomOS orchestrator — create and manage agents across workspaces.";

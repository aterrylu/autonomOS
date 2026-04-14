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

// ── Capabilities ─────────────────────────────────────────────────

/** Default capabilities granted when no template specifies them */
export const DEFAULT_CAPABILITIES: string[] = [
  "send",
  "list_agents",
  "create_agent",
  "kill_agent",
  "self_exit",
];

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
      forkFrom: {
        type: "string",
        description:
          "Claude session ID to fork from — child inherits parent's conversation context. Mutually exclusive with resumeSessionId.",
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
    properties: {
      includeExited: {
        type: "boolean",
        description:
          "Include exited agents in the chart (default: false, only running agents shown)",
      },
    },
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
        description: `Capabilities to grant: ${DEFAULT_CAPABILITIES.map((c) => `'${c}'`).join(", ")}. Defaults to all.`,
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

export const TOOL_SELF_EXIT: ToolDef = {
  name: "self_exit",
  description:
    "Terminate your own session. Use when your work is complete and you want to exit cleanly.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ── Schedule Tools ──────────────────────────────────────────────

export const TOOL_CREATE_SCHEDULE: ToolDef = {
  name: "create_schedule",
  description:
    "Create a new scheduled task that runs on a cron schedule or once at a specific time.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Schedule name (lowercase, hyphens, e.g. 'daily-github-summary')",
      },
      schedule: {
        type: "string",
        description:
          'Cron expression (e.g. "0 9 * * 1-5") or one-time (e.g. "once:2026-04-15T09:00")',
      },
      target: {
        type: "string",
        description:
          '"isolated" (headless claude -p) or "agent:<name>" (send to running agent)',
      },
      prompt: {
        type: "string",
        description: "The prompt/task to execute on each run",
      },
      workingDirectory: {
        type: "string",
        description: "Working directory for isolated execution (~ allowed)",
      },
      description: {
        type: "string",
        description: "Human-readable description of what this schedule does",
      },
      timezone: {
        type: "string",
        description:
          "IANA timezone (e.g. 'America/Los_Angeles'). Defaults to server local.",
      },
      template: {
        type: "string",
        description: "Template name for isolated mode execution",
      },
      autonomous: {
        type: "boolean",
        description: "Skip permission prompts in isolated mode (default: true)",
        default: true,
      },
      overlapPolicy: {
        type: "string",
        description:
          '"skip" (default, skip if previous run active) or "allow" (run regardless)',
      },
      onComplete: {
        type: "string",
        description:
          "Gateway URI to send results to when run completes (isolated mode only)",
      },
      notify: {
        type: "string",
        description:
          '"always", "failure" (default), or "never" — when to send notifications',
      },
      enabled: {
        type: "boolean",
        description: "Whether the schedule is active (default: true)",
        default: true,
      },
    },
    required: ["name", "schedule", "target", "prompt", "workingDirectory"],
  },
};

export const TOOL_LIST_SCHEDULES: ToolDef = {
  name: "list_schedules",
  description: "List all scheduled tasks with their config and current state.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const TOOL_GET_SCHEDULE: ToolDef = {
  name: "get_schedule",
  description: "Get a schedule's full config, state, and recent run history.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name",
      },
    },
    required: ["name"],
  },
};

export const TOOL_UPDATE_SCHEDULE: ToolDef = {
  name: "update_schedule",
  description:
    "Update a schedule's config (partial merge). State is preserved.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name to update",
      },
      schedule: { type: "string", description: "New cron expression" },
      target: { type: "string", description: "New target" },
      prompt: { type: "string", description: "New prompt" },
      workingDirectory: {
        type: "string",
        description: "New working directory",
      },
      description: { type: "string", description: "New description" },
      timezone: { type: "string", description: "New timezone" },
      template: { type: "string", description: "New template" },
      autonomous: { type: "boolean", description: "New autonomous mode" },
      overlapPolicy: { type: "string", description: "New overlap policy" },
      onComplete: { type: "string", description: "New onComplete URI" },
      notify: { type: "string", description: "New notify policy" },
      enabled: { type: "boolean", description: "Enable/disable" },
    },
    required: ["name"],
  },
};

export const TOOL_DELETE_SCHEDULE: ToolDef = {
  name: "delete_schedule",
  description: "Delete a schedule. Run history is preserved for audit.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name to delete",
      },
    },
    required: ["name"],
  },
};

export const TOOL_RUN_SCHEDULE: ToolDef = {
  name: "run_schedule",
  description:
    "Trigger a schedule immediately, ignoring cron timing. Respects overlap policy and concurrency limits.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Schedule name to trigger",
      },
    },
    required: ["name"],
  },
};

/** All tools — channel MCP gets these (filtered by capabilities) */
export const ALL_TOOLS: ToolDef[] = [
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
  TOOL_RUN_SCHEDULE,
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
  TOOL_CREATE_SCHEDULE,
  TOOL_LIST_SCHEDULES,
  TOOL_GET_SCHEDULE,
  TOOL_UPDATE_SCHEDULE,
  TOOL_DELETE_SCHEDULE,
  TOOL_RUN_SCHEDULE,
];

/**
 * Tools that require a matching capability to be visible.
 * Tools NOT in this set are always available (e.g. set_manager, get_org_chart).
 */
const CAPABILITY_GATED_TOOLS = new Set(DEFAULT_CAPABILITIES);

/** Filter ALL_TOOLS to only those the agent's capabilities allow */
export function filterToolsByCapabilities(capabilities: string[]): ToolDef[] {
  const allowed = new Set(capabilities);
  return ALL_TOOLS.filter((tool) => {
    return !CAPABILITY_GATED_TOOLS.has(tool.name) || allowed.has(tool.name);
  });
}

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
  'To respond: send(to: "<from_uri>", message: "your reply")',
].join("\n");

/** Instructions for external MCP clients (no channel/send capability) */
export const MCP_INSTRUCTIONS_EXTERNAL =
  "autonomOS orchestrator — create and manage agents across workspaces.";

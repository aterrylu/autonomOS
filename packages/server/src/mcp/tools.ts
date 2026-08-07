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

// NOTE: this module must not import from @autonomos/core.
//
// It is bundled into channel-server/dist.mjs with `--packages=external`, and
// build-binary.ts COPIES that file into the bundle dir (see RUNTIME_SCRIPTS in
// scriptPaths.ts). A bare `@autonomos/core` import survives bundling as an
// unresolved external and would fail to resolve from the copied location —
// breaking every agent spawn in the packaged build, at runtime only.
//
// So the permission-mode values below are duplicated from core rather than
// derived. `__tests__/tools-permission-schema.test.ts` asserts the copy matches
// PERMISSION_MODES / DEFAULT_PERMISSION_MODE exactly, which buys the same
// drift protection a shared import would, without the runtime dependency.

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
    "Create a new agent — a dedicated CLI session with a name, context, and optional task. Defaults to Claude Code; set `provider` to spawn a Codex or Gemini agent instead.",
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
          "Session id to resume: an autonomOS agent id OR a raw Claude Code session id — including an EXTERNAL session started via terminal `claude`. External sessions are adopted into a new managed agent and resumed.",
      },
      forkFrom: {
        type: "string",
        description:
          "Claude session ID to fork from — child inherits parent's conversation context. Mutually exclusive with resumeSessionId.",
      },
      permissionMode: {
        type: "string",
        enum: ["ask", "auto", "plan", "bypass"],
        // NO `default` key. It would say "omitting this yields ask", which is
        // false on every resume — omission PRESERVES the agent's current mode.
        // A client that materializes an advertised default would then send
        // `permissionMode: "ask"` explicitly on a resume and re-level a
        // deliberately autonomous agent: the exact demotion this schema's own
        // description tells it to avoid.
        description:
          "How much autonomy the agent has over tool use: 'ask' (prompt before each privileged action), 'auto' (auto-approve edits), 'plan' (read-only investigation — not supported by Codex, falls back to 'ask'), 'bypass' (skip all prompts). Omit to keep a resumed agent's existing mode, or to take the template's / 'ask' on a fresh spawn — pass 'bypass' explicitly for full autonomy.",
      },
      template: {
        type: "string",
        description:
          "Template name to base this agent on (e.g. 'team-lead', 'worker'). Templates define role, system prompt, and permission mode.",
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
      provider: {
        type: "string",
        enum: ["claude-code", "codex", "gemini-cli"],
        description:
          "Agent runtime/CLI to spawn (default: 'claude-code'). 'codex' = OpenAI Codex CLI, 'gemini-cli' = Google Gemini CLI. The chosen CLI must be installed on the host.",
      },
      envPreset: {
        type: "string",
        description:
          "Name of an env preset (see list_env_presets) to apply — e.g. run this Claude Code agent against a Kimi/Moonshot backend. Injects the preset's model-override env into ONLY this agent. The preset must have its API key set by a human in the dashboard first; spawning with a preset whose key is unset fails.",
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
      name: {
        type: "string",
        description:
          "Alias for 'agent' — agent name or session ID to terminate",
      },
    },
  },
};

export const TOOL_SEND: ToolDef = {
  name: "send",
  description:
    "Send a message to another agent. Use the from_uri from incoming messages to respond. " +
    "Succeeds only if the destination accepted the message; any other result explains why it did not. " +
    "Do not re-send a message reported as not-yet-delivered — a duplicate can make an agent act twice.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description:
          'Destination URI — "agent://name" (use list_agents to find names)',
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
      name: {
        type: "string",
        description:
          "Alias for 'agent' — agent name (e.g. 'Dashboard@autonomOS')",
      },
      manager: {
        type: "string",
        description:
          "Manager agent name (e.g. 'TeamLead@autonomOS'). Use null or empty to remove manager.",
      },
    },
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
    "Create a reusable agent template (blueprint) that defines a role, system prompt, and permission mode. Saved to ~/.autonomos/templates/.",
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
      permissionMode: {
        type: "string",
        enum: ["ask", "auto", "plan", "bypass"],
        description:
          "Tool-use autonomy for agents spawned from this template: 'ask' | 'auto' | 'plan' | 'bypass'. Omit to fall back to 'ask'.",
      },
      model: {
        type: "string",
        description:
          "Model override for litellm routing (e.g. 'opus', 'sonnet', 'haiku'). Omit for CC default.",
      },
      // Kept only to be reported as ignored, matching the HTTP MCP schema.
      // Agents spawned before ADR-058 still hold the old schema and keep
      // sending this; the write path answers with a deprecation notice rather
      // than dropping it silently. Remove once no pre-ADR-058 agent is running.
      capabilities: {
        type: "array",
        items: { type: "string" },
        description:
          "DEPRECATED (ADR-058) — ignored. It never restricted anything. Constrain workers in systemPrompt instead.",
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
          '"agent:<name>" — send the prompt to a running agent. That agent must be alive when the schedule fires; its own permission mode governs what the run may do.',
      },
      prompt: {
        type: "string",
        description: "The prompt/task to execute on each run",
      },
      // Kept so a client written before the isolated target was removed still
      // validates; the server ignores it. Marked in the description because a
      // silently-ignored field is exactly what makes an agent believe it
      // configured something it didn't.
      workingDirectory: {
        type: "string",
        description:
          "DEPRECATED — ignored. The run happens inside the target agent, in that agent's working directory.",
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
        description: "DEPRECATED — ignored. Never had an effect.",
      },
      // No `default: true` any more. It advertised that omitting the field
      // grants full autonomy, which is both untrue now and the shape that made
      // this the one scheduled-execution path outside PermissionMode.
      autonomous: {
        type: "boolean",
        description:
          "DEPRECATED — ignored. Autonomy is the target agent's own permissionMode; a schedule cannot change it.",
      },
      overlapPolicy: {
        type: "string",
        description:
          '"skip" (default, skip if previous run active) or "allow" (run regardless)',
      },
      onComplete: {
        type: "string",
        description:
          "DEPRECATED — ignored. Only ever fired for the removed isolated target; an agent: run 'completes' on delivery, before the agent has started.",
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
    // workingDirectory is NOT required — it is deprecated and ignored. Leaving
    // it here while the property description says DEPRECATED told a caller two
    // contradictory things, and forced an agent to invent a value for a dead
    // field (which the POST route then persisted verbatim). The channel server
    // is the path autonomOS-spawned agents actually use, so this array is the
    // contract they see.
    required: ["name", "schedule", "target", "prompt"],
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
      autonomous: {
        type: "boolean",
        description: "DEPRECATED — ignored. See create_schedule.",
      },
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

// ── Env Preset Tools (model-override, ADR-067) ──────────────────
//
// The AGENT surface for env presets. These tools set everything EXCEPT the
// secret VALUES: an agent declares which secret keys a preset needs but cannot
// write them — a human pastes the API key in the dashboard. Reads are masked.
// The tool descriptions tell agents not to solicit tokens in chat.

const ENV_PRESET_SECRET_GUIDANCE =
  "You CANNOT set the secret value (the API key/token) — that is entered by a human in the dashboard Presets tab. Do NOT ask the user to paste their API key in chat; tell them to open the Presets tab and fill it there. Declare the required key name(s) via `secretKeys`.";

// The full happy path, stated once so an agent doesn't have to reconstruct it
// from the individual tools (or learn it from a failed spawn).
const ENV_PRESET_WORKFLOW =
  'Full flow: (1) create_env_preset with its `env` + `secretKeys`; (2) tell the human to open the dashboard Presets tab and set the API key; (3) confirm it\'s set with list_env_presets (see its is-set rule); (4) THEN create_agent(envPreset: <name>). Spawning before the key is set fails with a clear message pointing at the Presets tab. For Kimi (Moonshot): ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic, ANTHROPIC_MODEL=kimi-k2.7-code (or kimi-k3), secretKeys=["ANTHROPIC_AUTH_TOKEN"] (note: AUTH_TOKEN, not API_KEY).';

export const TOOL_LIST_ENV_PRESETS: ToolDef = {
  name: "list_env_presets",
  description:
    "List env presets (model-override profiles, e.g. a Kimi/Moonshot backend). Secret values are always MASKED — never the values. IS-SET RULE: a secret key is SET when it appears in the returned `secrets` map (as a masked ••••value); a declared `secretKey` that is ABSENT from `secrets` is UNSET — a human still needs to fill it in the dashboard. Check this before spawning an agent with the preset.",
  inputSchema: { type: "object", properties: {} },
};

export const TOOL_CREATE_ENV_PRESET: ToolDef = {
  name: "create_env_preset",
  description: `Create an env preset — a named set of environment variables applied to an agent at spawn to override its model backend (e.g. point Claude Code at Kimi via ANTHROPIC_BASE_URL/ANTHROPIC_MODEL). ${ENV_PRESET_SECRET_GUIDANCE} ${ENV_PRESET_WORKFLOW}`,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Preset name (lowercase, digits, hyphens — used as the filename).",
      },
      description: {
        type: "string",
        description: "What this preset points at.",
      },
      provider: {
        type: "string",
        enum: ["claude-code", "codex", "gemini-cli"],
        description:
          "Base provider this override targets (default 'claude-code').",
      },
      label: {
        type: "string",
        description:
          "Short label shown on the agent's row in the dashboard (e.g. 'Kimi K2.7-code').",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          'Non-secret env vars, e.g. { "ANTHROPIC_BASE_URL": "https://api.moonshot.ai/anthropic", "ANTHROPIC_MODEL": "kimi-k2.7-code" }. Reserved autonomOS control-plane vars are rejected.',
      },
      secretKeys: {
        type: "array",
        items: { type: "string" },
        description:
          'Names of the secret env vars this preset needs (e.g. ["ANTHROPIC_AUTH_TOKEN"]). You declare the names; the human fills the values in the dashboard.',
      },
    },
    required: ["name"],
  },
};

export const TOOL_UPDATE_ENV_PRESET: ToolDef = {
  name: "update_env_preset",
  description: `Update an env preset's non-secret fields. ${ENV_PRESET_SECRET_GUIDANCE}`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the preset to update." },
      description: { type: "string" },
      provider: {
        type: "string",
        enum: ["claude-code", "codex", "gemini-cli"],
      },
      label: { type: "string" },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Replaces the non-secret env map.",
      },
      secretKeys: {
        type: "array",
        items: { type: "string" },
        description: "Replaces the declared secret-key names.",
      },
    },
    required: ["name"],
  },
};

export const TOOL_DELETE_ENV_PRESET: ToolDef = {
  name: "delete_env_preset",
  description: "Delete an env preset by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the preset to delete." },
    },
    required: ["name"],
  },
};

/** All tools — the channel MCP registers every one of these.
 *  Kept deliberately in sync with MCP_INSTRUCTIONS below: the instructions are
 *  injected verbatim into each agent's system prompt, so any tool advertised
 *  there must actually register. Per-template filtering was removed in ADR-058
 *  precisely because it broke that correspondence. */
export const ALL_TOOLS: ToolDef[] = [
  TOOL_CREATE_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_KILL_AGENT,
  TOOL_SEND,
  TOOL_SET_MANAGER,
  TOOL_GET_ORG_CHART,
  TOOL_LIST_TEMPLATES,
  TOOL_CREATE_TEMPLATE,
  TOOL_LIST_ENV_PRESETS,
  TOOL_CREATE_ENV_PRESET,
  TOOL_UPDATE_ENV_PRESET,
  TOOL_DELETE_ENV_PRESET,
  TOOL_SELF_EXIT,
  TOOL_CREATE_SCHEDULE,
  TOOL_LIST_SCHEDULES,
  TOOL_GET_SCHEDULE,
  TOOL_UPDATE_SCHEDULE,
  TOOL_DELETE_SCHEDULE,
  TOOL_RUN_SCHEDULE,
];

// SERVER_TOOLS (the HTTP-MCP subset) was removed here: it had zero consumers.
// mcp.ts registers its tools through individual McpServer.tool() calls with
// their own zod schemas rather than reading an array. It survived only because
// it sat beside ALL_TOOLS, which did have one.

// ── Shared MCP metadata ──────────────────────────────────────────

export const MCP_SERVER_INFO = {
  name: "autonomos",
  version: "0.3.0",
} as const;

// The single source of truth for the tool prose injected into every agent's
// system prompt (via BASE_CONTEXT) AND advertised as the channel MCP server's
// `instructions`. EVERY tool in ALL_TOOLS must be named here and nothing else —
// `mcp-instructions-sync.test.ts` enforces that correspondence, so this can't
// silently drift as tools are added or removed (which it had: env-preset tools
// were only added by hand, and a stale "platforms" line outlived ADR-064).
export const MCP_INSTRUCTIONS = [
  "You are running inside autonomOS — an agent orchestration platform.",
  "",
  "### Finding & messaging other agents",
  "- list_agents(): the LIVE fleet — every active agent with its name, agent:// URI, status, and permission mode. This is the ONLY authoritative list of your peers. Do NOT rely on any provider-native or built-in agent list (e.g. a per-thread/collaboration list): those do not see autonomOS peers, and reading one will make you conclude you are alone when you are not. When in doubt, call list_agents().",
  "- send(to, message): message ONE agent by its agent://<name> URI (from list_agents, or an incoming message's from_uri). There is no broadcast — address each recipient. A send succeeds only when the destination ACCEPTED the message; any other result explains why. Do NOT re-send a message reported as not-yet-delivered — a duplicate can make an agent act twice (a not-delivered message on the Codex path is auto-retried; re-sending stacks a second copy).",
  "",
  "### Managing the fleet & org chart",
  "- create_agent(): spawn a new dedicated agent (optionally from a template, or with an env preset — see below)",
  "- kill_agent(): terminate an agent",
  "- set_manager(): set an agent's manager in the org chart",
  "- get_org_chart(): view the agent hierarchy",
  "- list_templates() / create_template(): browse and create reusable agent blueprints (role, system prompt, permission mode)",
  "- self_exit(): end your own session when your work is complete",
  "",
  "### Env presets — model overrides (e.g. run an agent on Kimi)",
  "Flow: create_env_preset (set env + declare the secret key NAMES) → a human sets the API key in the dashboard Presets tab (do NOT ask for tokens in chat) → verify it's set with list_env_presets → create_agent(envPreset: <name>). Spawning with an unset key fails.",
  "- list_env_presets(): list presets; secret values are masked, and a declared secretKey absent from `secrets` is UNSET",
  "- create_env_preset() / update_env_preset(): configure a preset — you set env + secretKeys but CANNOT set the secret value (the human does)",
  "- delete_env_preset(): remove a preset",
  "",
  "### Schedules",
  "- create_schedule(): a recurring (cron) or one-time task delivered to a running agent, which does the work under its own permission mode",
  "- list_schedules() / get_schedule() / update_schedule() / delete_schedule() / run_schedule(): inspect and manage schedules",
  "",
  "### Receiving messages",
  "Messages from other agents arrive as <channel> events, each with `from` (sender name) and `from_uri` (the address to reply to).",
  'To reply: send(to: "<from_uri>", message: "your reply").',
].join("\n");

/** Instructions for external MCP clients (no channel/send capability) */
export const MCP_INSTRUCTIONS_EXTERNAL =
  "autonomOS orchestrator — create and manage agents across workspaces.";

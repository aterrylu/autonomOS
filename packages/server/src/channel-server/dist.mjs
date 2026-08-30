#!/usr/bin/env node

// packages/server/src/channel-server/index.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

// packages/server/src/gateway/deliveryTimings.ts
var GATEWAY_REQUEST_TIMEOUT_MS = 5e3;

// packages/server/src/version.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
function getServerVersion() {
  const candidates = [
    // Bundled layout: bundle dir contains the JS + its package.json
    resolve(import.meta.dirname, "package.json"),
    // Source layout: src/ → packages/server/package.json
    resolve(import.meta.dirname, "../package.json"),
    // Source channel-server layout: src/channel-server/ → packages/server/
    resolve(import.meta.dirname, "../../package.json")
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
    }
  }
  return "unknown";
}

// packages/server/src/mcp/tools.ts
var TOOL_CREATE_AGENT = {
  name: "create_agent",
  description: "Create a new agent \u2014 a dedicated CLI session with a name, context, and optional task. Defaults to Claude Code; set `provider` to spawn a Codex or Gemini agent instead.",
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
        description: "Session id to resume: an autonomOS agent id OR a raw Claude Code session id \u2014 including an EXTERNAL session started via terminal `claude`. External sessions are adopted into a new managed agent and resumed."
      },
      forkFrom: {
        type: "string",
        description: "Agent id to fork from \u2014 child inherits parent's conversation context. Mutually exclusive with resumeSessionId."
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
        description: "How much autonomy the agent has over tool use: 'ask' (prompt before each privileged action), 'auto' (auto-approve edits), 'plan' (read-only investigation \u2014 not supported by Codex, falls back to 'ask'), 'bypass' (skip all prompts). Omit to keep a resumed agent's existing mode, or to take the template's / 'ask' on a fresh spawn \u2014 pass 'bypass' explicitly for full autonomy."
      },
      template: {
        type: "string",
        description: "Template name to base this agent on (e.g. 'team-lead', 'worker'). Templates define role, system prompt, and permission mode."
      },
      manager: {
        type: "string",
        description: "Manager agent name (e.g. 'TeamLead@autonomOS'). Sets the org chart relationship."
      },
      project: {
        type: "string",
        description: "Project scope (e.g. 'autonomOS', 'homelab'). Used in role@project naming."
      },
      provider: {
        type: "string",
        enum: ["claude-code", "codex", "gemini-cli"],
        description: "Agent runtime/CLI to spawn (default: 'claude-code'). 'codex' = OpenAI Codex CLI, 'gemini-cli' = Google Gemini CLI. The chosen CLI must be installed on the host."
      },
      envPreset: {
        type: "string",
        description: "Name of an env preset (see list_env_presets) to apply \u2014 e.g. run this Claude Code agent against a Kimi/Moonshot backend. Injects the preset's model-override env into ONLY this agent. The preset must have its API key set by a human in the dashboard first; spawning with a preset whose key is unset fails."
      }
    },
    required: ["workingDirectory"]
  }
};
var TOOL_LIST_AGENTS = {
  name: "list_agents",
  annotations: { readOnlyHint: true },
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
  description: "Send a message to another agent. Use the from_uri from incoming messages to respond. Succeeds only if the destination accepted the message; any other result explains why it did not. Do not re-send a message reported as not-yet-delivered \u2014 a duplicate can make an agent act twice.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: 'Destination URI \u2014 "agent://name" (use list_agents to find names)'
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
        description: "Manager agent name (e.g. 'TeamLead@autonomOS'). Omit (or pass an empty string) to remove the manager."
      }
    }
  }
};
var TOOL_GET_ORG_CHART = {
  name: "get_org_chart",
  annotations: { readOnlyHint: true },
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
  annotations: { readOnlyHint: true },
  description: "List available agent templates (blueprints for creating agents with predefined roles).",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var TOOL_CREATE_TEMPLATE = {
  name: "create_template",
  description: "Create a reusable agent template (blueprint) that defines a role, system prompt, and permission mode. Saved to ~/.autonomos/templates/.",
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
      permissionMode: {
        type: "string",
        enum: ["ask", "auto", "plan", "bypass"],
        description: "Tool-use autonomy for agents spawned from this template: 'ask' | 'auto' | 'plan' | 'bypass'. Omit to fall back to 'ask'."
      },
      model: {
        type: "string",
        description: "Model override for litellm routing (e.g. 'opus', 'sonnet', 'haiku'). Omit for CC default."
      },
      // Kept only to be reported as ignored, matching the HTTP MCP schema.
      // Agents spawned before ADR-058 still hold the old schema and keep
      // sending this; the write path answers with a deprecation notice rather
      // than dropping it silently. Remove once no pre-ADR-058 agent is running.
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "DEPRECATED (ADR-058) \u2014 ignored. It never restricted anything. Constrain workers in systemPrompt instead."
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
        description: '"agent:<name>" \u2014 send the prompt to a running agent. That agent must be alive when the schedule fires; its own permission mode governs what the run may do.'
      },
      prompt: {
        type: "string",
        description: "The prompt/task to execute on each run"
      },
      // Kept so a client written before the isolated target was removed still
      // validates; the server ignores it. Marked in the description because a
      // silently-ignored field is exactly what makes an agent believe it
      // configured something it didn't.
      workingDirectory: {
        type: "string",
        description: "DEPRECATED \u2014 ignored. The run happens inside the target agent, in that agent's working directory."
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
        description: "DEPRECATED \u2014 ignored. Never had an effect."
      },
      // No `default: true` any more. It advertised that omitting the field
      // grants full autonomy, which is both untrue now and the shape that made
      // this the one scheduled-execution path outside PermissionMode.
      autonomous: {
        type: "boolean",
        description: "DEPRECATED \u2014 ignored. Autonomy is the target agent's own permissionMode; a schedule cannot change it."
      },
      overlapPolicy: {
        type: "string",
        description: '"skip" (default, skip if previous run active) or "allow" (run regardless)'
      },
      onComplete: {
        type: "string",
        description: "DEPRECATED \u2014 ignored. Only ever fired for the removed isolated target; an agent: run 'completes' on delivery, before the agent has started."
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
    // workingDirectory is NOT required — it is deprecated and ignored. Leaving
    // it here while the property description says DEPRECATED told a caller two
    // contradictory things, and forced an agent to invent a value for a dead
    // field (which the POST route then persisted verbatim). The channel server
    // is the path autonomOS-spawned agents actually use, so this array is the
    // contract they see.
    required: ["name", "schedule", "target", "prompt"]
  }
};
var TOOL_LIST_SCHEDULES = {
  name: "list_schedules",
  annotations: { readOnlyHint: true },
  description: "List all scheduled tasks with their config and current state.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};
var TOOL_GET_SCHEDULE = {
  name: "get_schedule",
  annotations: { readOnlyHint: true },
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
      autonomous: {
        type: "boolean",
        description: "DEPRECATED \u2014 ignored. See create_schedule."
      },
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
var ENV_PRESET_SECRET_GUIDANCE = "You CANNOT set the secret value (the API key/token) \u2014 that is entered by a human in the dashboard Presets tab. Do NOT ask the user to paste their API key in chat; tell them to open the Presets tab and fill it there. Declare the required key name(s) via `secretKeys`.";
var ENV_PRESET_WORKFLOW = 'Full flow: (1) create_env_preset with its `env` + `secretKeys`; (2) tell the human to open the dashboard Presets tab and set the API key; (3) confirm it\'s set with list_env_presets (see its is-set rule); (4) THEN create_agent(envPreset: <name>). Spawning before the key is set fails with a clear message pointing at the Presets tab. For Kimi (Moonshot): ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic, ANTHROPIC_MODEL=kimi-k2.7-code (or kimi-k3), secretKeys=["ANTHROPIC_AUTH_TOKEN"] (note: AUTH_TOKEN, not API_KEY).';
var TOOL_LIST_ENV_PRESETS = {
  name: "list_env_presets",
  annotations: { readOnlyHint: true },
  description: "List env presets (model-override profiles, e.g. a Kimi/Moonshot backend). Secret values are always MASKED \u2014 never the values. IS-SET RULE: a secret key is SET when it appears in the returned `secrets` map (as a masked \u2022\u2022\u2022\u2022value); a declared `secretKey` that is ABSENT from `secrets` is UNSET \u2014 a human still needs to fill it in the dashboard. Check this before spawning an agent with the preset.",
  inputSchema: { type: "object", properties: {} }
};
var TOOL_CREATE_ENV_PRESET = {
  name: "create_env_preset",
  description: `Create an env preset \u2014 a named set of environment variables applied to an agent at spawn to override its model backend (e.g. point Claude Code at Kimi via ANTHROPIC_BASE_URL/ANTHROPIC_MODEL). ${ENV_PRESET_SECRET_GUIDANCE} ${ENV_PRESET_WORKFLOW}`,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Preset name (lowercase, digits, hyphens \u2014 used as the filename)."
      },
      description: {
        type: "string",
        description: "What this preset points at."
      },
      provider: {
        type: "string",
        enum: ["claude-code", "codex", "gemini-cli"],
        description: "Base provider this override targets (default 'claude-code')."
      },
      label: {
        type: "string",
        description: "Short label shown on the agent's row in the dashboard (e.g. 'Kimi K2.7-code')."
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: 'Non-secret env vars, e.g. { "ANTHROPIC_BASE_URL": "https://api.moonshot.ai/anthropic", "ANTHROPIC_MODEL": "kimi-k2.7-code" }. Reserved autonomOS control-plane vars are rejected.'
      },
      secretKeys: {
        type: "array",
        items: { type: "string" },
        description: 'Names of the secret env vars this preset needs (e.g. ["ANTHROPIC_AUTH_TOKEN"]). You declare the names; the human fills the values in the dashboard.'
      }
    },
    required: ["name"]
  }
};
var TOOL_UPDATE_ENV_PRESET = {
  name: "update_env_preset",
  description: `Update an env preset's non-secret fields. ${ENV_PRESET_SECRET_GUIDANCE}`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the preset to update." },
      description: { type: "string" },
      provider: {
        type: "string",
        enum: ["claude-code", "codex", "gemini-cli"]
      },
      label: { type: "string" },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Replaces the non-secret env map."
      },
      secretKeys: {
        type: "array",
        items: { type: "string" },
        description: "Replaces the declared secret-key names."
      }
    },
    required: ["name"]
  }
};
var TOOL_DELETE_ENV_PRESET = {
  name: "delete_env_preset",
  description: "Delete an env preset by name.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the preset to delete." }
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
  TOOL_RUN_SCHEDULE
];
var MCP_SERVER_INFO = {
  name: "autonomos",
  version: getServerVersion()
};
var MCP_INSTRUCTIONS = [
  "You are running inside autonomOS \u2014 an agent orchestration platform.",
  "",
  "### Finding & messaging other agents",
  "- list_agents(): the LIVE fleet \u2014 every active agent with its name, agent:// URI, status, and permission mode. This is the ONLY authoritative list of your peers. Do NOT rely on any provider-native or built-in agent list (e.g. a per-thread/collaboration list): those do not see autonomOS peers, and reading one will make you conclude you are alone when you are not. When in doubt, call list_agents().",
  "- send(to, message): message ONE agent by its agent://<name> URI (from list_agents, or an incoming message's from_uri). There is no broadcast \u2014 address each recipient. A send succeeds only when the destination ACCEPTED the message; any other result explains why. Do NOT re-send a message reported as not-yet-delivered \u2014 a duplicate can make an agent act twice (a not-delivered message on the Codex path is auto-retried; re-sending stacks a second copy).",
  "",
  "### Managing the fleet & org chart",
  "- create_agent(): spawn a new dedicated agent (optionally from a template, or with an env preset \u2014 see below)",
  "- kill_agent(): terminate an agent",
  "- set_manager(): set an agent's manager in the org chart",
  "- get_org_chart(): view the agent hierarchy",
  "- list_templates() / create_template(): browse and create reusable agent blueprints (role, system prompt, permission mode)",
  "- self_exit(): end your own session when your work is complete",
  "",
  "### Env presets \u2014 model overrides (e.g. run an agent on Kimi)",
  "Flow: create_env_preset (set env + declare the secret key NAMES) \u2192 a human sets the API key in the dashboard Presets tab (do NOT ask for tokens in chat) \u2192 verify it's set with list_env_presets \u2192 create_agent(envPreset: <name>). Spawning with an unset key fails.",
  "- list_env_presets(): list presets; secret values are masked, and a declared secretKey absent from `secrets` is UNSET",
  "- create_env_preset() / update_env_preset(): configure a preset \u2014 you set env + secretKeys but CANNOT set the secret value (the human does)",
  "- delete_env_preset(): remove a preset",
  "",
  "### Schedules",
  "- create_schedule(): a recurring (cron) or one-time task delivered to a running agent, which does the work under its own permission mode",
  "- list_schedules() / get_schedule() / update_schedule() / delete_schedule() / run_schedule(): inspect and manage schedules",
  "",
  "### Receiving messages",
  "Messages from other agents arrive as <channel> events, each with `from` (sender name) and `from_uri` (the address to reply to).",
  'To reply: send(to: "<from_uri>", message: "your reply").',
  "A `schedule://<name>` from_uri is NOT an agent \u2014 it names the scheduled task that fired the prompt. Schedules cannot receive replies: just do the task. To inspect or change that schedule, use get_schedule/update_schedule/delete_schedule with its name."
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
var AGENT_TOKEN = (() => {
  const configDir = process.env.AUTONOMOS_CONFIG_DIR;
  const safeSession = /^[A-Za-z0-9._-]+$/.test(SESSION_ID) && !SESSION_ID.includes("..");
  if (configDir && safeSession) {
    try {
      return readFileSync2(
        join(configDir, "agent-tokens", SESSION_ID),
        "utf8"
      ).trim();
    } catch {
    }
  }
  return process.env.AUTONOMOS_AGENT_TOKEN;
})();
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
      sessionId: SESSION_ID,
      // Per-agent identity (ADR-055 PR B): prove we are this session, not just
      // asserting its id. Undefined only for a pre-PR-B server that didn't set
      // it — the gateway then rejects, which is correct for a new server.
      agentToken: AGENT_TOKEN
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
  ws.addEventListener("close", (event) => {
    ws = null;
    if (event.code === 1008) {
      process.stderr.write(
        `autonomos-channel: gateway REJECTED our per-agent credential (1008: ${event.reason || "policy violation"}) \u2014 NOT reconnecting; retrying cannot help. Check AUTONOMOS_AGENT_TOKEN injection.
`
      );
      return;
    }
    process.stderr.write("autonomos-channel: disconnected from gateway\n");
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
function requestGateway(msg, requestId, timeoutMs, defaultOnTimeout, defaultOnNotSent = defaultOnTimeout) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve(defaultOnNotSent);
  }
  return new Promise((resolve2) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve2(defaultOnTimeout);
    }, timeoutMs);
    pendingRequests.set(requestId, {
      resolve: resolve2,
      timer
    });
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve2(defaultOnNotSent);
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
  const explicit = process.env.AUTONOMOS_API_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const wsUrl = SERVER_URL ?? "";
  if (wsUrl.startsWith("ws+unix:")) {
    process.stderr.write(
      "autonomos-channel: AUTONOMOS_API_URL not set with a ws+unix gateway \u2014 create_agent/kill_agent/schedules will be unavailable\n"
    );
    return "";
  }
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
      const result = await requestGateway(
        wsMsg,
        requestId,
        GATEWAY_REQUEST_TIMEOUT_MS,
        {
          success: false,
          error: "The gateway did not answer in time, so it is unknown whether this message was delivered. Check the agent's state before re-sending."
        },
        {
          success: false,
          error: "NOT sent \u2014 this agent's gateway connection is down, so nothing was transmitted. Retrying is safe."
        }
      );
      if (!result.success) {
        return {
          content: [{ type: "text", text: result.error ?? "Send failed" }],
          isError: true
        };
      }
      return {
        content: [
          {
            type: "text",
            text: result.note ?? `Accepted for delivery to ${to}`
          }
        ]
      };
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
      const lines = agents.map(
        (a) => [
          `${a.name} (${a.uri}) \u2014 ${a.status}`,
          a.permissionMode ? ` \u2014 ${a.permissionMode}` : ""
        ].join("")
      );
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
        permissionMode,
        template,
        manager,
        project,
        provider,
        envPreset
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
            // Raw CC/agent session id — the server's polymorphic resolver
            // reattaches a managed record or adopts an external CC session.
            resumeSessionId,
            forkFromAgentId: forkFrom,
            // Pass through, INCLUDING undefined. /api/agents owns the
            // fallback so it can prefer a resumed agent's own record over it —
            // do not substitute a default here.
            permissionMode,
            appendSystemPrompt: systemPrompt,
            template,
            manager: effectiveManager,
            project,
            provider,
            envPreset
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
    // ── Env preset tools (model overrides, ADR-067) ─────────────
    // SECURITY: we forward ONLY the non-secret fields. `secrets` is picked out
    // and dropped even if an agent crafts it into args — the agent surface can
    // never write a secret value. (The REST route does accept secrets, for the
    // human dashboard path.)
    case "create_env_preset": {
      const { name: name2, description, provider, label, env, secretKeys } = args;
      return serverFetch("/api/env-presets", {
        method: "POST",
        body: JSON.stringify({
          name: name2,
          description,
          provider,
          label,
          env,
          secretKeys
        })
      });
    }
    case "update_env_preset": {
      const { name: name2, description, provider, label, env, secretKeys } = args;
      return serverFetch(`/api/env-presets/${encodeURIComponent(name2)}`, {
        method: "PUT",
        body: JSON.stringify({ description, provider, label, env, secretKeys })
      });
    }
    case "list_env_presets": {
      return serverFetch("/api/env-presets");
    }
    case "delete_env_preset": {
      const { name: name2 } = args;
      return serverFetch(`/api/env-presets/${encodeURIComponent(name2)}`, {
        method: "DELETE"
      });
    }
    case "self_exit": {
      serverFetch(`/api/agents/${encodeURIComponent(SESSION_ID)}/kill`, {
        method: "POST",
        body: JSON.stringify({ reason: "self_exited" })
      }).then((res) => {
        if (res.isError) {
          process.stderr.write(
            `autonomos-channel: self_exit kill rejected: ${res.content?.[0]?.text ?? "unknown"}
`
          );
        }
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

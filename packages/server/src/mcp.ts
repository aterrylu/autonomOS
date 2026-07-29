import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_PERMISSION_MODE,
  LEGACY_PERMISSION_MODE_SPELLINGS,
  PERMISSION_MODES,
  permissionModeFromStored,
} from "@autonomos/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  killAttachment,
  resolveAgentId,
  spawnAgent,
} from "./agents/runtime.js";
import {
  buildAgentTree,
  CachePoisonedError,
  listAgents,
  resolveAgentByName,
  setManager,
} from "./agents/store.js";
import { emitAgentDelta } from "./events/agents.js";
import { MCP_INSTRUCTIONS_EXTERNAL, MCP_SERVER_INFO } from "./mcp/tools.js";
import {
  addScheduleJob,
  removeScheduleJob,
  runScheduleNow,
} from "./scheduler.js";
import {
  createSchedule,
  deleteSchedule,
  getRecentRuns,
  getSchedule,
  listSchedules,
  updateSchedule,
  validateScheduleInput,
} from "./schedules.js";
import {
  DEPRECATED_CAPABILITIES_NOTE,
  getTemplate,
  listTemplates,
  saveTemplate,
} from "./templates.js";

// ── MCP Server (HTTP transport — for external clients) ─────────────────
// Claude Desktop, CI pipelines, other MCP clients can connect here.
// Does NOT include `send` tool — that requires the gateway WebSocket.

/** Server-side org chart node for get_org_chart MCP tool. */
interface OrgNode {
  id: string;
  name: string;
  template?: string;
  project?: string;
  status: "running" | "exited";
  children: OrgNode[];
}

function buildOrgChartFromAgents(includeExited = false): OrgNode[] {
  return buildAgentTree<OrgNode>({
    includeExited,
    mapNode: (a) => ({
      id: a.id,
      name: a.name,
      template: a.template,
      project: a.project,
      status: a.status,
    }),
  });
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS_EXTERNAL,
    },
  );

  server.tool(
    "create_agent",
    "Create a new agent — a dedicated CLI session with a name, context, and optional task. Defaults to Claude Code; set `provider` to spawn a Codex or Gemini agent instead.",
    {
      workingDirectory: z
        .string()
        .describe("Absolute path to the working directory (~ allowed)"),
      name: z.string().optional().describe("Display name for the agent"),
      systemPrompt: z
        .string()
        .optional()
        .describe(
          "Instructions appended to the system prompt. Defines role/goals.",
        ),
      prompt: z
        .string()
        .optional()
        .describe("Initial task or message — what the agent starts working on"),
      resumeSessionId: z
        .string()
        .optional()
        .describe(
          "Session id to resume: an autonomOS agent id, OR a raw Claude Code session id — including an EXTERNAL session started via terminal `claude` (discovered in the Projects panel). External sessions are adopted into a new managed agent and resumed.",
        ),
      forkFrom: z
        .string()
        .optional()
        .describe(
          "Agent id to fork from — child inherits parent's conversation context. Mutually exclusive with resumeSessionId.",
        ),
      // The legacy spelling is accepted (and normalized) rather than rejected:
      // every agent spawned before the rename still holds the OLD tool schema
      // in its context and will keep sending "default". Rejecting it would turn
      // a rename into a hard tool failure for the already-running fleet. It is
      // deliberately absent from the description so nobody learns it as current.
      permissionMode: z
        .enum([...PERMISSION_MODES, ...LEGACY_PERMISSION_MODE_SPELLINGS])
        .optional()
        .transform(permissionModeFromStored)
        .describe(
          "Tool-use autonomy: 'ask' (prompt before each action), 'auto' (auto-approve edits), 'plan' (read-only; Codex falls back to 'ask'), 'bypass' (skip all prompts). Omit to keep a resumed agent's existing mode, or to take the template's / 'ask' on a fresh spawn — pass 'bypass' explicitly for full autonomy.",
        ),
      template: z
        .string()
        .optional()
        .describe("Template name (e.g. 'team-lead', 'worker')"),
      manager: z
        .string()
        .optional()
        .describe("Manager agent name for org chart"),
      project: z
        .string()
        .optional()
        .describe("Project scope (e.g. 'autonomOS')"),
      provider: z
        .enum(["claude-code", "codex", "gemini-cli"])
        .optional()
        .describe(
          "Agent runtime/CLI (default: 'claude-code'). 'codex' = OpenAI Codex CLI, 'gemini-cli' = Google Gemini CLI. Must be installed on the host.",
        ),
    },
    async (args) => {
      try {
        const tmpl = args.template ? getTemplate(args.template) : null;
        if (args.template && !tmpl) {
          return {
            content: [
              {
                type: "text",
                text: `Template "${args.template}" not found. Use list_templates to see available templates.`,
              },
            ],
            isError: true,
          };
        }

        // Resolve manager name → managerId (if provided)
        let managerId: string | null = null;
        if (args.manager) {
          const mgr = resolveAgentByName(args.manager);
          if (!mgr) {
            return {
              content: [
                {
                  type: "text",
                  text: `Manager "${args.manager}" not found. Spawn it first or omit the manager argument.`,
                },
              ],
              isError: true,
            };
          }
          managerId = mgr.id;
        }

        const systemPrompt = args.systemPrompt ?? tmpl?.systemPrompt;
        // Forwarded as-is, INCLUDING undefined — spawnAgent owns the fallback
        // so it can prefer a resumed agent's own record over it. Collapsing to
        // DEFAULT_PERMISSION_MODE here made a body-less resume overwrite a
        // `bypass` record with the fallback. See SpawnParams.
        const permissionMode = args.permissionMode;

        const result = await spawnAgent({
          workingDirectory: args.workingDirectory,
          prompt: args.prompt,
          name: args.name,
          // Polymorphic resolver in spawnAgent: reattaches a managed record
          // (by agent id or providerSessionId) or adopts an external CC session.
          resumeSessionId: args.resumeSessionId,
          forkFromAgentId: args.forkFrom,
          permissionMode,
          // Ranked BELOW the record on a resume — see SpawnParams.
          templatePermissionMode: tmpl?.permissionMode,
          appendSystemPrompt: systemPrompt,
          template: args.template,
          managerId,
          project: args.project,
          provider: args.provider,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(result.agent, null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to create agent: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "list_agents",
    "List all active agents with their status, working directory, and metadata.",
    {},
    async () => {
      const agents = listAgents();
      return {
        content: [
          {
            type: "text",
            text:
              agents.length === 0
                ? "No agents."
                : JSON.stringify(agents, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "kill_agent",
    "Terminate an active agent by name or id.",
    {
      agent: z.string().optional().describe("Agent name or id to terminate"),
      name: z
        .string()
        .optional()
        .describe("Alias for 'agent' — agent name or id to terminate"),
    },
    async (args) => {
      const target = args.agent || args.name;
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `Missing parameter: provide 'agent' or 'name'. Usage: kill_agent(agent: "AgentName")`,
            },
          ],
          isError: true,
        };
      }
      const resolved = await resolveAgentId(target);
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: resolved.error }],
          isError: true,
        };
      }
      if (!killAttachment(resolved.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${target}" was found but had no live attachment to terminate.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Agent "${target}" terminated.` }],
      };
    },
  );

  server.tool(
    "set_manager",
    "Set an agent's manager in the org chart.",
    {
      agent: z
        .string()
        .optional()
        .describe("Agent name (e.g. 'Dashboard@autonomOS')"),
      name: z
        .string()
        .optional()
        .describe(
          "Alias for 'agent' — agent name (e.g. 'Dashboard@autonomOS')",
        ),
      manager: z
        .string()
        .optional()
        .describe("Manager agent name, or omit to remove manager"),
    },
    async (args) => {
      const target = args.agent || args.name;
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `Missing parameter: provide 'agent' or 'name'. Usage: set_manager(agent: "AgentName", manager: "ManagerName")`,
            },
          ],
          isError: true,
        };
      }
      const agent = resolveAgentByName(target);
      if (!agent) {
        return {
          content: [{ type: "text", text: `Agent "${target}" not found.` }],
          isError: true,
        };
      }

      let managerId: string | null = null;
      if (args.manager) {
        const mgr = resolveAgentByName(args.manager);
        if (!mgr) {
          return {
            content: [
              {
                type: "text",
                text: `Manager "${args.manager}" not found.`,
              },
            ],
            isError: true,
          };
        }
        managerId = mgr.id;
      }

      // setManager → writeAgentFile is throw-capable on lastReadFailed
      // (cache/disk divergence guard added by the agent-unification PR).
      // Catch and surface the same CACHE_POISONED signal the REST surface
      // emits via 503, so MCP clients see a stable error code instead of
      // a generic "Failed to set manager" attribution that would imply
      // a transient issue safe to retry.
      let result: ReturnType<typeof setManager>;
      try {
        result = setManager(agent.id, managerId);
      } catch (err) {
        if (err instanceof CachePoisonedError) {
          console.error(
            `[mcp] set_manager hit CACHE_POISONED for ${target}: ${err.message}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `CACHE_POISONED: ${err.message} (server's view of disk is degraded; retry pointless until the operator restarts the server).`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
      if (result === "cycle") {
        return {
          content: [
            {
              type: "text",
              text: `Cycle: "${args.manager}" is a descendant of "${target}".`,
            },
          ],
          isError: true,
        };
      }
      // setManager returns Agent | undefined | "cycle" | "stale".
      // "cycle" handled above; everything other than an Agent is a failure.
      if (!result || typeof result === "string") {
        return {
          content: [{ type: "text", text: `Failed to set manager.` }],
          isError: true,
        };
      }
      emitAgentDelta({
        type: "agent.reparented",
        id: result.id,
        managerId: result.managerId,
        version: result.version,
      });
      return {
        content: [
          {
            type: "text",
            text: args.manager
              ? `Set ${target}'s manager to ${args.manager}.`
              : `Removed ${target}'s manager.`,
          },
        ],
      };
    },
  );

  server.tool(
    "get_org_chart",
    "Get the organization chart showing all agents and their hierarchy.",
    {
      includeExited: z
        .boolean()
        .optional()
        .describe("Include exited agents (default: false, only running)"),
    },
    async ({ includeExited }) => {
      const chart = buildOrgChartFromAgents(includeExited);
      return {
        content: [
          {
            type: "text",
            text:
              chart.length === 0
                ? "No agents with hierarchy configured."
                : JSON.stringify(chart, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "list_templates",
    "List available agent templates.",
    {},
    async () => {
      const templates = listTemplates();
      const names = Object.keys(templates);
      return {
        content: [
          {
            type: "text",
            text:
              names.length === 0
                ? "No templates found. Use create_template to define one."
                : JSON.stringify(templates, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "create_template",
    "Create a reusable agent template.",
    {
      name: z
        .string()
        .describe("Template name (lowercase, hyphens, e.g. 'feature-worker')"),
      role: z.string().describe("Human-readable role name"),
      description: z.string().describe("Short description of the template"),
      systemPrompt: z
        .string()
        .describe("System prompt defining the agent's behavior"),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe(
          "Tool-use autonomy for agents spawned from this template: 'ask' | 'auto' | 'plan' | 'bypass'. Omit to fall back to 'ask'.",
        ),
      model: z
        .string()
        .optional()
        .describe("Model override (e.g. 'opus', 'haiku')"),
      // Declared solely so it can be REPORTED as ignored. Zod strips unknown
      // keys, so without this the field vanishes silently — and agents spawned
      // before ADR-058 still hold the old schema and keep sending it. Naming it
      // deprecated here also teaches the fleet, which is the whole thesis of
      // ADR-058: tell the agent, don't hide from it. Removable once no
      // pre-ADR-058 agent is still running.
      capabilities: z
        .array(z.string())
        .optional()
        .describe(
          "DEPRECATED (ADR-058) — ignored. It never restricted anything. Constrain workers in systemPrompt instead.",
        ),
    },
    async (args) => {
      try {
        saveTemplate(args.name, {
          role: args.role,
          description: args.description,
          systemPrompt: args.systemPrompt,
          permissionMode: args.permissionMode ?? DEFAULT_PERMISSION_MODE,
          model: args.model,
        });
        if (args.capabilities) {
          console.warn(
            `[mcp] ignoring deprecated 'capabilities' on template "${args.name}"`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Template "${args.name}" created at ~/.autonomos/templates/${args.name}.json` +
                (args.capabilities
                  ? `\n\n${DEPRECATED_CAPABILITIES_NOTE}`
                  : ""),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to create template: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Schedule tools ──────────────────────────────────────────────

  server.tool(
    "create_schedule",
    "Create a new scheduled task.",
    {
      name: z.string().describe("Schedule name (kebab-case)"),
      schedule: z.string().describe("Cron expression or once:ISO"),
      target: z.string().describe('"isolated" or "agent:<name>"'),
      prompt: z.string().describe("Task prompt"),
      workingDirectory: z.string().describe("Working directory"),
      description: z.string().optional().describe("Description"),
      timezone: z.string().optional().describe("IANA timezone"),
      template: z.string().optional().describe("Template name"),
      autonomous: z.boolean().optional().default(true),
      overlapPolicy: z.string().optional().describe("skip or allow"),
      onComplete: z.string().optional().describe("Gateway URI for results"),
      notify: z.string().optional().describe("always, failure, or never"),
      enabled: z.boolean().optional().default(true),
    },
    async (args) => {
      try {
        const config =
          args as unknown as import("@autonomos/core").ScheduleConfig;
        const validationError = validateScheduleInput(config);
        if (validationError) {
          return {
            content: [{ type: "text", text: `Failed: ${validationError}` }],
            isError: true,
          };
        }
        const schedule = createSchedule(config);
        addScheduleJob(schedule.name, schedule);
        const fresh = getSchedule(schedule.name) ?? schedule;
        return {
          content: [
            {
              type: "text",
              text: `Schedule "${fresh.name}" created. Next run: ${fresh.state.nextRunAt ?? "pending"}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool("list_schedules", "List all scheduled tasks.", {}, async () => {
    const schedules = listSchedules();
    const names = Object.keys(schedules);
    if (names.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No schedules. Use create_schedule to add one.",
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(schedules, null, 2) }],
    };
  });

  server.tool(
    "get_schedule",
    "Get schedule details and recent runs.",
    { name: z.string().describe("Schedule name") },
    async (args) => {
      const schedule = getSchedule(args.name);
      if (!schedule) {
        return {
          content: [
            { type: "text", text: `Schedule "${args.name}" not found.` },
          ],
          isError: true,
        };
      }
      const runs = getRecentRuns(args.name, 10);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...schedule, recentRuns: runs }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "update_schedule",
    "Update a schedule's configuration (partial merge).",
    {
      name: z.string().describe("Schedule name"),
      schedule: z.string().optional(),
      target: z.string().optional(),
      prompt: z.string().optional(),
      workingDirectory: z.string().optional(),
      description: z.string().optional(),
      timezone: z.string().optional(),
      template: z.string().optional(),
      autonomous: z.boolean().optional(),
      overlapPolicy: z.string().optional(),
      onComplete: z.string().optional(),
      notify: z.string().optional(),
      enabled: z.boolean().optional(),
    },
    async (args) => {
      try {
        const { name, ...partial } = args;
        const existing = getSchedule(name);
        const validationError = validateScheduleInput(
          partial as import("@autonomos/core").ScheduleConfig,
          { existing: existing ?? undefined },
        );
        if (validationError) {
          return {
            content: [{ type: "text", text: `Failed: ${validationError}` }],
            isError: true,
          };
        }
        const updated = updateSchedule(
          name,
          partial as Record<string, unknown>,
        );
        if (
          "schedule" in partial ||
          "timezone" in partial ||
          "enabled" in partial
        ) {
          addScheduleJob(name, updated);
        }
        return {
          content: [
            {
              type: "text",
              text: `Schedule "${name}" updated. Next run: ${updated.state.nextRunAt ?? "disabled"}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "delete_schedule",
    "Delete a schedule (run history preserved).",
    { name: z.string().describe("Schedule name") },
    async (args) => {
      removeScheduleJob(args.name);
      const removed = deleteSchedule(args.name);
      if (!removed) {
        return {
          content: [
            { type: "text", text: `Schedule "${args.name}" not found.` },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Schedule "${args.name}" deleted.` }],
      };
    },
  );

  server.tool(
    "run_schedule",
    "Trigger a schedule immediately.",
    { name: z.string().describe("Schedule name") },
    async (args) => {
      const result = runScheduleNow(args.name);
      if (result.error) {
        return {
          content: [{ type: "text", text: result.error }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Schedule "${args.name}" triggered.` }],
      };
    },
  );

  return server;
}

export { createMcpServer as _createMcpServerForTesting };

// ── Transport ─────────────────────────────────────────────────────────

const mcpServer = createMcpServer();
const transports = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, body);
    return;
  }

  if (body && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
        console.log(`MCP session initialized: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
        console.log(`MCP session closed: ${transport.sessionId}`);
      }
    };

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid or missing MCP session" },
      id: null,
    }),
  );
}

export async function handleMcpSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }
  res.writeHead(400, { "Content-Type": "text/plain" });
  res.end("Invalid or missing MCP session");
}

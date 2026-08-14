import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_PERMISSION_MODE } from "@autonomos/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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
import {
  createEnvPreset,
  deleteEnvPreset,
  listEnvPresets,
  updateEnvPreset,
} from "./envPresets.js";
import { emitAgentDelta } from "./events/agents.js";
import {
  MCP_INSTRUCTIONS_EXTERNAL,
  MCP_SERVER_INFO,
  TOOL_CREATE_AGENT,
  TOOL_CREATE_ENV_PRESET,
  TOOL_CREATE_SCHEDULE,
  TOOL_CREATE_TEMPLATE,
  TOOL_DELETE_ENV_PRESET,
  TOOL_DELETE_SCHEDULE,
  TOOL_GET_ORG_CHART,
  TOOL_GET_SCHEDULE,
  TOOL_KILL_AGENT,
  TOOL_LIST_AGENTS,
  TOOL_LIST_ENV_PRESETS,
  TOOL_LIST_SCHEDULES,
  TOOL_LIST_TEMPLATES,
  TOOL_RUN_SCHEDULE,
  TOOL_SELF_EXIT,
  TOOL_SET_MANAGER,
  TOOL_UPDATE_ENV_PRESET,
  TOOL_UPDATE_SCHEDULE,
} from "./mcp/tools.js";
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
// Request shapes live in ONE place (validation.ts) — the same objects back the
// REST routes, so the two surfaces can no longer drift apart field by field.
import {
  createAgentShape,
  createEnvPresetShape,
  createScheduleShape,
  createTemplateShape,
  deleteScheduleShape,
  envPresetNameShape,
  killAgentShape,
  orgChartShape,
  runScheduleShape,
  scheduleNameShape,
  setManagerShape,
  updateEnvPresetShape,
  updateScheduleShape,
} from "./validation.js";

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
    TOOL_CREATE_AGENT.description,
    createAgentShape,
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
          envPreset: args.envPreset,
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

  server.tool("list_agents", TOOL_LIST_AGENTS.description, {}, async () => {
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
  });

  server.tool(
    "kill_agent",
    TOOL_KILL_AGENT.description,
    killAgentShape,
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
    TOOL_SET_MANAGER.description,
    setManagerShape,
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
    TOOL_GET_ORG_CHART.description,
    orgChartShape,
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
    TOOL_LIST_TEMPLATES.description,
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
    TOOL_CREATE_TEMPLATE.description,
    createTemplateShape,
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

  // ── Env preset tools (model overrides, ADR-067) ─────────────────
  // Agents set env + declare secret KEY NAMES but never write secret VALUES;
  // reads are masked by the storage layer. See mcp/tools.ts for descriptions.

  const KEY_IN_UI_NOTE =
    "Now ask the human to open the dashboard Presets tab and paste the API key for the declared secret key(s). Do NOT request the token in chat.";

  server.tool(
    "list_env_presets",
    TOOL_LIST_ENV_PRESETS.description,
    {},
    async () => {
      try {
        return {
          content: [
            { type: "text", text: JSON.stringify(listEnvPresets(), null, 2) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to list presets: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "create_env_preset",
    TOOL_CREATE_ENV_PRESET.description,
    createEnvPresetShape,
    async (args) => {
      try {
        // No `secrets` in the schema AND no `writeSecrets` here — the agent
        // surface cannot set values, and the store enforces that even if this
        // call site ever changed.
        const preset = createEnvPreset(
          {
            name: args.name,
            description: args.description,
            provider: args.provider,
            label: args.label,
            env: args.env,
            secretKeys: args.secretKeys,
          },
          Date.now(),
        );
        return {
          content: [
            {
              type: "text",
              text: `${JSON.stringify(preset, null, 2)}\n\n${KEY_IN_UI_NOTE}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to create preset: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "update_env_preset",
    TOOL_UPDATE_ENV_PRESET.description,
    updateEnvPresetShape,
    async (args) => {
      try {
        const preset = updateEnvPreset(
          args.name,
          {
            description: args.description,
            provider: args.provider,
            label: args.label,
            env: args.env,
            secretKeys: args.secretKeys,
          },
          Date.now(),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(preset, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to update preset: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "delete_env_preset",
    TOOL_DELETE_ENV_PRESET.description,
    envPresetNameShape,
    async (args) => {
      try {
        const removed = deleteEnvPreset(args.name);
        return {
          content: [
            {
              type: "text",
              text: removed
                ? `Preset "${args.name}" deleted`
                : `Preset "${args.name}" not found`,
            },
          ],
          isError: !removed,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            { type: "text", text: `Failed to delete preset: ${message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Schedule tools ──────────────────────────────────────────────

  server.tool(
    "create_schedule",
    TOOL_CREATE_SCHEDULE.description,
    createScheduleShape,
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

  server.tool(
    "list_schedules",
    TOOL_LIST_SCHEDULES.description,
    {},
    async () => {
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
    },
  );

  server.tool(
    "get_schedule",
    TOOL_GET_SCHEDULE.description,
    scheduleNameShape,
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
    TOOL_UPDATE_SCHEDULE.description,
    updateScheduleShape,
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
    TOOL_DELETE_SCHEDULE.description,
    deleteScheduleShape,
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
    TOOL_RUN_SCHEDULE.description,
    runScheduleShape,
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

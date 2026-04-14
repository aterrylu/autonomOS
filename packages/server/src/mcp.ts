import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCapability } from "@autonomos/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DEFAULT_CAPABILITIES,
  MCP_INSTRUCTIONS_EXTERNAL,
  MCP_SERVER_INFO,
} from "./mcp/tools.js";
import { buildOrgChart } from "./orgChart.js";
import { updatePersistedSessionByName } from "./persisted.js";
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
} from "./schedules.js";
import {
  createSession,
  getAllSessions,
  killSession,
  resolveSessionId,
} from "./sessions.js";
import { getTemplate, listTemplates, saveTemplate } from "./templates.js";

// ── MCP Server (HTTP transport — for external clients) ─────────────────
// Claude Desktop, CI pipelines, other MCP clients can connect here.
// Does NOT include `send` tool — that requires the gateway WebSocket.

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
    "Create a new agent — a dedicated Claude Code session with a name, context, and optional task.",
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
        .describe("Claude Code session ID to resume"),
      forkFrom: z
        .string()
        .optional()
        .describe(
          "Claude session ID to fork from — child inherits parent's conversation context. Mutually exclusive with resumeSessionId.",
        ),
      autonomousMode: z
        .boolean()
        .optional()
        .default(true)
        .describe("Skip permission prompts (default: true)"),
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
    },
    async (args) => {
      try {
        // Resolve template if provided
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

        // Determine system prompt: explicit > template > none
        const systemPrompt = args.systemPrompt ?? tmpl?.systemPrompt;
        const autonomousMode =
          args.autonomousMode ?? tmpl?.autonomousMode ?? true;

        const managed = createSession({
          workingDirectory: args.workingDirectory,
          prompt: args.prompt,
          name: args.name,
          resumeSessionId: args.resumeSessionId,
          forkFrom: args.forkFrom,
          autonomousMode,
          appendSystemPrompt: systemPrompt,
          template: args.template,
          manager: args.manager,
          project: args.project,
        });
        return {
          content: [
            { type: "text", text: JSON.stringify(managed.session, null, 2) },
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
      const sessions = getAllSessions();
      return {
        content: [
          {
            type: "text",
            text:
              sessions.length === 0
                ? "No active agents."
                : JSON.stringify(sessions, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "kill_agent",
    "Terminate an active agent by name or session ID.",
    {
      agent: z.string().describe("Agent name or session ID to terminate"),
    },
    async (args) => {
      // Try exact ID match first
      if (killSession(args.agent)) {
        return {
          content: [
            { type: "text", text: `Agent "${args.agent}" terminated.` },
          ],
        };
      }
      // Fall back to name resolution (case-insensitive, titleCache)
      const resolved = await resolveSessionId(args.agent);
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: resolved.error }],
          isError: true,
        };
      }
      if (!killSession(resolved.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${args.agent}" was found but exited before it could be terminated.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Agent "${args.agent}" terminated.` }],
      };
    },
  );

  server.tool(
    "set_manager",
    "Set an agent's manager in the org chart.",
    {
      agent: z.string().describe("Agent name (e.g. 'Dashboard@autonomOS')"),
      manager: z
        .string()
        .optional()
        .describe("Manager agent name, or omit to remove manager"),
    },
    async (args) => {
      const ok = updatePersistedSessionByName(args.agent, {
        manager: args.manager ?? undefined,
      });
      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text: `Agent "${args.agent}" not found.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: args.manager
              ? `Set ${args.agent}'s manager to ${args.manager}.`
              : `Removed ${args.agent}'s manager.`,
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
      const chart = buildOrgChart(includeExited);
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
      capabilities: z
        .array(z.string())
        .optional()
        .describe(`Capabilities: ${DEFAULT_CAPABILITIES.join(", ")}`),
      autonomousMode: z
        .boolean()
        .optional()
        .describe("Skip permission prompts (default: true)"),
      model: z
        .string()
        .optional()
        .describe("Model override (e.g. 'opus', 'haiku')"),
    },
    async (args) => {
      try {
        saveTemplate(args.name, {
          role: args.role,
          description: args.description,
          systemPrompt: args.systemPrompt,
          capabilities:
            (args.capabilities as AgentCapability[]) ??
            (DEFAULT_CAPABILITIES as AgentCapability[]),
          autonomousMode: args.autonomousMode ?? true,
          model: args.model,
        });
        return {
          content: [
            {
              type: "text",
              text: `Template "${args.name}" created at ~/.autonomos/templates/${args.name}.json`,
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

  // ── Schedule tools ───────────────────────────────────────────────

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
        const schedule = createSchedule(config);
        addScheduleJob(schedule.name, schedule);
        return {
          content: [
            {
              type: "text",
              text: `Schedule "${schedule.name}" created. Next run: ${schedule.state.nextRunAt ?? "pending"}`,
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

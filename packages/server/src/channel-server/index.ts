#!/usr/bin/env node

/**
 * server:autonomos — MCP channel server for Claude Code
 *
 * Standalone script spawned by Claude Code as a subprocess.
 * Bridges MCP (stdio, to Claude Code) and WebSocket (to autonomOS gateway).
 *
 * Tools (mirrored from server MCP + gateway-specific):
 *   send(to, message)   — send to one agent: agent://name
 *   list_agents()       — discover agents with their URIs
 *   create_agent(...)   — spawn a new dedicated agent
 *   kill_agent(agent)   — terminate an agent by name or ID
 *
 * Environment variables (set by autonomOS at spawn time):
 *   AUTONOMOS_SERVER_URL  — gateway WebSocket URL (ws+unix://<sock>:/ws/gateway, ADR-055 PR B)
 *   AUTONOMOS_SESSION_ID  — this agent's autonomOS session ID
 *   AUTONOMOS_CONFIG_DIR  — locates this agent's 0600 per-agent token file
 *
 * Credentials: ONLY the per-agent token (security audit V3). REST calls and the
 * gateway upgrade both go over the internal Unix socket with X-Agent-Session +
 * X-Agent-Token. The operator token is never given to an agent.
 */

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type {
  AgentInfo,
  GatewayMessage,
  GatewayWsMessage,
  PermissionMode,
} from "@autonomos/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// The gateway listens on a Unix socket, addressed as
// `ws+unix://<socketPath>:/ws/gateway`. Node's built-in global WebSocket (undici)
// rejects that scheme outright ("expected a ws: or wss: url"); the `ws` package
// supports it, splitting socketPath from request-path on the FIRST ':'. So this
// import is load-bearing, not stylistic — do not drop back to the global.
// (biome's import sorter keeps this comment with the line below.)
import WebSocket from "ws";

// Tool definitions are shared with the HTTP MCP server.
// Import paths use relative since this runs as a standalone subprocess.
// At build time, esbuild resolves these from the same package.
import {
  GATEWAY_REQUEST_TIMEOUT_MS,
  MAX_GATEWAY_FRAME_BYTES,
} from "../gateway/deliveryTimings.js";
import { ALL_TOOLS, MCP_INSTRUCTIONS, MCP_SERVER_INFO } from "../mcp/tools.js";

const SESSION_ID = process.env.AUTONOMOS_SESSION_ID;
const SERVER_URL = process.env.AUTONOMOS_SERVER_URL;

if (!SESSION_ID || !SERVER_URL) {
  process.stderr.write(
    "autonomos-channel: AUTONOMOS_SESSION_ID and AUTONOMOS_SERVER_URL required\n",
  );
  process.exit(1);
}

/**
 * The per-agent token (ADR-055 follow-up), presented in the gateway `register`.
 *
 * Read from the per-session FILE `<configDir>/agent-tokens/<sessionId>`, a path
 * derived from AUTONOMOS_CONFIG_DIR + AUTONOMOS_SESSION_ID — both non-secret env
 * names every provider propagates (unlike AUTONOMOS_AGENT_TOKEN, which Gemini
 * filters out of the MCP subprocess env, and which was world-readable argv for
 * Codex). Falls back to the env var for a mixed-version window (a pre-follow-up
 * server that still injected it), so a Claude/Codex agent spawned by an older
 * server still registers.
 */
const AGENT_TOKEN = ((): string | undefined => {
  const configDir = process.env.AUTONOMOS_CONFIG_DIR;
  // Validate SESSION_ID inline before using it as a path segment. The server's
  // write side already guards this (assertSafeSessionId in agentCredentials.ts),
  // so today this is transitively safe — but this is a standalone bundled
  // subprocess deriving a filesystem path from an env var it was handed, and it
  // should not trust that the value is well-formed just because the current
  // caller happens to be. A `/` or `..` here must never traverse out of the
  // agent-tokens dir. Fail to the env fallback rather than read an escaped path.
  const safeSession =
    /^[A-Za-z0-9._-]+$/.test(SESSION_ID) && !SESSION_ID.includes("..");
  if (configDir && safeSession) {
    try {
      return readFileSync(
        join(configDir, "agent-tokens", SESSION_ID),
        "utf8",
      ).trim();
    } catch {
      // No file (older server, or already revoked) — fall back to env.
    }
  }
  return process.env.AUTONOMOS_AGENT_TOKEN;
})();

// ── WebSocket connection to autonomOS server ──────────────────────

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

// Pending requests waiting for gateway response
const pendingRequests = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function connectToServer(): void {
  try {
    // The upgrade authenticates with the per-agent credential (audit V3);
    // the register frame below still proves the session identity.
    ws = new WebSocket(SERVER_URL!, { headers: agentHeaders() });
  } catch (err) {
    process.stderr.write(
      `autonomos-channel: WebSocket connect failed: ${err}\n`,
    );
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectDelay = 1000;
    const msg: GatewayWsMessage = {
      type: "register",
      sessionId: SESSION_ID!,
      // Per-agent identity (ADR-055 PR B): prove we are this session, not just
      // asserting its id. Undefined only for a pre-PR-B server that didn't set
      // it — the gateway then rejects, which is correct for a new server.
      agentToken: AGENT_TOKEN,
    };
    ws?.send(JSON.stringify(msg));
    process.stderr.write("autonomos-channel: connected to gateway\n");
  });

  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString(),
      ) as GatewayWsMessage;
      handleServerMessage(msg);
    } catch (err) {
      process.stderr.write(`autonomos-channel: bad message: ${err}\n`);
    }
  });

  ws.addEventListener("close", (event) => {
    ws = null;
    // 1008 (policy violation) is how the gateway rejects a bad/missing
    // per-agent credential (ADR-055 PR B). Reconnecting is POINTLESS — the
    // token can't change within this process's lifetime — so a silent backoff
    // loop here would turn a credential misconfig into an undiagnosable "agent
    // went quiet". Say so loudly and STOP. The server-side
    // scheduleChannelServerCheck surfaces the never-registered agent as a
    // dashboard SystemWarning within its grace window, so the operator still
    // gets a signal even though stderr isn't shown.
    if (event.code === 1008) {
      process.stderr.write(
        "autonomos-channel: gateway REJECTED our per-agent credential " +
          `(1008: ${event.reason || "policy violation"}) — NOT reconnecting; ` +
          "retrying cannot help. Check AUTONOMOS_AGENT_TOKEN injection.\n",
      );
      return;
    }
    process.stderr.write("autonomos-channel: disconnected from gateway\n");
    scheduleReconnect();
  });

  ws.addEventListener("error", (err) => {
    process.stderr.write(`autonomos-channel: ws error: ${err}\n`);
  });
}

function scheduleReconnect(): void {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToServer();
  }, reconnectDelay);
}

function handleServerMessage(msg: GatewayWsMessage): void {
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

/**
 * Send a WS message and wait for a correlated response.
 *
 * Two failure results, not one. A TIMEOUT means the request went out and the
 * gateway never answered — the outcome is genuinely unknown, and a blind
 * re-send risks a duplicate. NOT-SENT (socket closed, or `send()` threw) means
 * nothing left this process, so re-sending is unambiguously safe and correct.
 *
 * They were the same value until ADR-064, which is only a wording bug while the
 * ack is vague — but the timeout text now says "unknown whether this message
 * was delivered, check before re-sending", and telling an agent that when
 * nothing was transmitted discourages the exact action it should take.
 */
function requestGateway<T>(
  msg: GatewayWsMessage,
  requestId: string,
  timeoutMs: number,
  defaultOnTimeout: T,
  defaultOnNotSent: T = defaultOnTimeout,
): Promise<T> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve(defaultOnNotSent);
  }
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(defaultOnTimeout);
    }, timeoutMs);
    pendingRequests.set(requestId, {
      resolve: resolve as (result: unknown) => void,
      timer,
    });
    try {
      ws!.send(JSON.stringify(msg));
    } catch {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve(defaultOnNotSent);
    }
  });
}

// ── MCP Server ────────────────────────────────────────────────────

const mcp = new Server(
  { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: MCP_INSTRUCTIONS,
  },
);

// ── Tool handlers ─────────────────────────────────────────────────
// Uses shared tool definitions from mcp/tools.ts.
// Handlers route through the gateway WebSocket for send/list_agents,
// and through the server's HTTP API for create_agent/kill_agent.

// REST goes to the internal Unix socket, the same one the gateway uses:
// `ws+unix://<socketPath>:/ws/gateway` (the `ws` package splits on the FIRST
// ':' after the scheme, and so do we). That socket is 0600 and same-user, and
// it is where the server accepts the per-agent credential for exactly the
// routes these tools call (routes/agentApi.ts, audit V3). The public port
// never accepts an agent credential.
const SOCKET_PATH = (() => {
  const url = SERVER_URL ?? "";
  if (!url.startsWith("ws+unix://")) return "";
  const rest = url.slice("ws+unix://".length);
  const colon = rest.indexOf(":");
  return colon > 0 ? rest.slice(0, colon) : "";
})();
if (!SOCKET_PATH) {
  process.stderr.write(
    "autonomos-channel: AUTONOMOS_SERVER_URL is not a ws+unix:// gateway URL — " +
      "create_agent/kill_agent/schedules will be unavailable\n",
  );
}

/** MCP tool result shape (index signature required by MCP SDK) */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** This agent's credential, for REST calls and the gateway upgrade. */
function agentHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (SESSION_ID) headers["X-Agent-Session"] = SESSION_ID;
  if (AGENT_TOKEN) headers["X-Agent-Token"] = AGENT_TOKEN;
  return headers;
}

/** One HTTP request over the internal socket. */
function socketRequest(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    const req = httpRequest(
      {
        socketPath: SOCKET_PATH,
        path,
        method: init?.method ?? "GET",
        headers: {
          ...agentHeaders(),
          ...(body !== undefined && {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          }),
          ...(init?.headers as Record<string, string>),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Call the autonomOS server API and return an MCP tool result */
async function serverFetch(
  path: string,
  init?: RequestInit,
): Promise<ToolResult> {
  if (!SOCKET_PATH) {
    return {
      content: [
        {
          type: "text",
          text: "Failed: no internal socket to reach the server on",
        },
      ],
      isError: true,
    };
  }
  const res = await socketRequest(path, init);
  if (res.status < 200 || res.status >= 300) {
    return {
      content: [{ type: "text", text: `Failed: ${res.text}` }],
      isError: true,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = res.text;
  }
  const pretty =
    typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
  return { content: [{ type: "text", text: pretty }] };
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "send": {
      const { to, message } = args as { to?: string; message?: string };
      if (!to || !message) {
        return {
          content: [
            {
              type: "text",
              text: `Missing required parameter(s). Usage: send(to: "agent://name", message: "your message")`,
            },
          ],
          isError: true,
        };
      }
      const requestId = crypto.randomUUID();
      const wsMsg: GatewayWsMessage = {
        type: "send",
        to,
        message,
        requestId,
      };
      // The gateway closes a socket that sends a frame over its limit (1009),
      // with no reply, so an oversized send would wait out the whole request
      // deadline and then look like a lost message. Refuse it here, clearly,
      // before touching the socket.
      const frameBytes = Buffer.byteLength(JSON.stringify(wsMsg));
      if (frameBytes > MAX_GATEWAY_FRAME_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `Message NOT sent: it is too large (${frameBytes} bytes; the limit is ${MAX_GATEWAY_FRAME_BYTES}). Send a shorter message, or put the content in a file and send its path.`,
            },
          ],
          isError: true,
        };
      }
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true,
        };
      }

      // The gateway now confirms DELIVERY rather than routing, so this wait has
      // to outlast the gateway's own ack window plus its name-resolution work.
      // At the old 2s the two deadlines raced: a delivery the gateway confirmed
      // just after the window would arrive to a request we had already given up
      // on and deleted, and the agent was told "timeout" for a message that
      // landed. Both numbers now live in deliveryTimings.ts with a test pinning
      // the ordering, because a comment on each side enforced nothing.
      const result = await requestGateway<{
        success: boolean;
        error?: string;
        // Optional sender-facing note on a manual-queue accept ("accepted —
        // queued for hand-delivery"). Present only when success is true.
        note?: string;
      }>(
        wsMsg,
        requestId,
        GATEWAY_REQUEST_TIMEOUT_MS,
        {
          success: false,
          error:
            "The gateway did not answer in time, so it is unknown whether this " +
            "message was delivered. Check the agent's state before re-sending.",
        },
        {
          success: false,
          error:
            "NOT sent — this agent's gateway connection is down, so nothing " +
            "was transmitted. Retrying is safe.",
        },
      );

      if (!result.success) {
        return {
          content: [{ type: "text", text: result.error ?? "Send failed" }],
          isError: true,
        };
      }
      // "Accepted for delivery", not "Delivered" — the router's own vocabulary.
      // For Codex this means the daemon took the turn; for Claude Code it means
      // the frame reached its channel-server socket, which is NOT a receipt that
      // the agent saw it. The sender cannot tell which provider the recipient
      // is, so the word has to be true for the weaker of the two.
      //
      // A manual-queue recipient (Gemini) carries a `note` — "accepted, queued
      // for hand-delivery" — which is honest per ADR-064 (accepted, NOT
      // delivered) and MORE informative than the generic string, so prefer it.
      return {
        content: [
          {
            type: "text",
            text: result.note ?? `Accepted for delivery to ${to}`,
          },
        ],
      };
    }

    case "list_agents": {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return {
          content: [{ type: "text", text: "Not connected to gateway" }],
          isError: true,
        };
      }
      const requestId = crypto.randomUUID();
      const wsMsg: GatewayWsMessage = {
        type: "list_agents_request",
        requestId,
      };
      const agents = await requestGateway<AgentInfo[]>(
        wsMsg,
        requestId,
        5000,
        [],
      );

      if (agents.length === 0) {
        return {
          content: [
            { type: "text", text: "No active agents (or request timed out)." },
          ],
        };
      }
      // Permission mode is included because this listing is the ONLY fleet view
      // a spawned agent has, and without it an agent could not check a peer's
      // autonomy — only assume it. That gap is what turned one confused restart
      // into a loop: the restart had taken effect, but nothing could say so.
      // Omitted (rather than guessed) when an older server didn't send one.
      const lines = agents.map((a) =>
        [
          `${a.name} (${a.uri}) — ${a.status}`,
          // The runtime's own values (ADR-115); the legacy mode only from an
          // older server that doesn't send them.
          a.permission
            ? ` — ${a.permission}`
            : a.permissionMode
              ? ` — ${a.permissionMode}`
              : "",
        ].join(""),
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    case "create_agent": {
      // Route through the server's HTTP API — the channel server can't
      // call createSession() directly since it's a separate process.
      const {
        workingDirectory,
        name: agentName,
        systemPrompt,
        prompt,
        resumeSessionId,
        forkFrom,
        permissionMode,
        permission,
        template,
        manager,
        project,
        provider,
        envPreset,
      } = args as {
        workingDirectory: string;
        name?: string;
        systemPrompt?: string;
        prompt?: string;
        resumeSessionId?: string;
        forkFrom?: string;
        permissionMode?: PermissionMode;
        permission?: string;
        template?: string;
        manager?: string;
        project?: string;
        provider?: string;
        envPreset?: string;
      };

      // Auto-default manager to calling agent's name (channel server only)
      const effectiveManager = manager ?? process.env.AUTONOMOS_AGENT_NAME;
      if (!manager && effectiveManager) {
        process.stderr.write(
          `autonomos-channel: auto-setting manager to "${effectiveManager}"\n`,
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
            permission,
            appendSystemPrompt: systemPrompt,
            template,
            manager: effectiveManager,
            project,
            provider,
            envPreset,
          }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `autonomos-channel: create_agent failed: ${msg}\n`,
        );
        return {
          content: [{ type: "text", text: `Failed to create agent: ${msg}` }],
          isError: true,
        };
      }
    }

    case "kill_agent": {
      const { agent, name: nameAlias } = args as {
        agent?: string;
        name?: string;
      };
      const target = agent || nameAlias;
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
      try {
        const result = await serverFetch(
          `/api/agents/${encodeURIComponent(target)}/kill`,
          { method: "POST" },
        );
        if (result.isError) return result;
        return {
          content: [{ type: "text", text: `Agent "${target}" terminated.` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to kill agent: ${err instanceof Error ? err.message : err}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "set_manager": {
      const {
        agent,
        name: nameAlias,
        manager,
      } = args as {
        agent?: string;
        name?: string;
        manager?: string;
      };
      const setTarget = agent || nameAlias;
      if (!setTarget) {
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
      return serverFetch(
        `/api/agents/${encodeURIComponent(setTarget)}/manager`,
        {
          method: "POST",
          body: JSON.stringify({ manager: manager ?? null }),
        },
      );
    }

    case "get_org_chart": {
      const { includeExited } = args as { includeExited?: boolean };
      const qs = includeExited ? "?includeExited=true" : "";
      return serverFetch(`/api/agents/tree${qs}`);
    }

    case "create_template": {
      return serverFetch("/api/templates", {
        method: "POST",
        body: JSON.stringify(args),
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
      const { name, description, provider, label, env, secretKeys } = args as {
        name?: string;
        description?: string;
        provider?: string;
        label?: string;
        env?: Record<string, string>;
        secretKeys?: string[];
      };
      return serverFetch("/api/env-presets", {
        method: "POST",
        body: JSON.stringify({
          name,
          description,
          provider,
          label,
          env,
          secretKeys,
        }),
      });
    }

    case "update_env_preset": {
      const { name, description, provider, label, env, secretKeys } = args as {
        name: string;
        description?: string;
        provider?: string;
        label?: string;
        env?: Record<string, string>;
        secretKeys?: string[];
      };
      return serverFetch(`/api/env-presets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ description, provider, label, env, secretKeys }),
      });
    }

    case "list_env_presets": {
      return serverFetch("/api/env-presets");
    }

    case "delete_env_preset": {
      const { name } = args as { name: string };
      return serverFetch(`/api/env-presets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    }

    case "self_exit": {
      // Fire-and-forget: /kill stops our PTY (and this subprocess). The
      // response may or may not reach the agent before the process dies.
      //
      // We POST /kill (soft-exit: keeps the agent record as status:"exited",
      // exitReason:"self_exited") rather than DELETE (which rmSync's the
      // record off disk). Preserving the record is what lets a later
      // create_agent({ resumeSessionId }) find it via getAgent() and resume —
      // a DELETE'd record returns undefined → "resumeAgentId not found".
      serverFetch(`/api/agents/${encodeURIComponent(SESSION_ID!)}/kill`, {
        method: "POST",
        body: JSON.stringify({ reason: "self_exited" }),
      })
        .then((res) => {
          // serverFetch resolves (does not reject) on a non-2xx response,
          // packaging it as { isError: true }. Surface those HTTP-level
          // failures (e.g. a 409 PTY-already-gone race) to stderr too —
          // otherwise the only diagnostic fires for transport errors alone.
          if (res.isError) {
            process.stderr.write(
              `autonomos-channel: self_exit kill rejected: ${res.content?.[0]?.text ?? "unknown"}\n`,
            );
          }
        })
        .catch((err) => {
          process.stderr.write(
            `autonomos-channel: self_exit failed: ${err instanceof Error ? err.message : err}\n`,
          );
        });
      return { content: [{ type: "text", text: "Exiting..." }] };
    }

    // ── Schedule tools (route through server HTTP API) ──────────
    case "create_schedule":
      return serverFetch("/api/schedules", {
        method: "POST",
        body: JSON.stringify(args),
      });

    case "list_schedules":
      return serverFetch("/api/schedules");

    case "get_schedule": {
      const { name: schedName } = args as { name: string };
      return serverFetch(`/api/schedules/${encodeURIComponent(schedName)}`);
    }

    case "update_schedule": {
      const { name: schedName, ...schedPartial } = args as {
        name: string;
        [key: string]: unknown;
      };
      return serverFetch(`/api/schedules/${encodeURIComponent(schedName)}`, {
        method: "PUT",
        body: JSON.stringify(schedPartial),
      });
    }

    case "delete_schedule": {
      const { name: schedName } = args as { name: string };
      return serverFetch(`/api/schedules/${encodeURIComponent(schedName)}`, {
        method: "DELETE",
      });
    }

    case "run_schedule": {
      const { name: schedName } = args as { name: string };
      return serverFetch(
        `/api/schedules/${encodeURIComponent(schedName)}/run`,
        { method: "POST" },
      );
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Channel notification delivery ─────────────────────────────────

function deliverToClaudeCode(msg: GatewayMessage): void {
  // Prepend sender info so the terminal display shows who sent it
  const content = `[${msg.userName} → you via ${msg.fromUri}]\n${msg.text}`;

  mcp
    .notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          from: msg.userName,
          from_uri: msg.fromUri,
          ts: new Date(msg.timestamp).toISOString(),
        },
      },
    })
    .catch((err) => {
      process.stderr.write(
        `autonomos-channel: failed to deliver notification: ${err}\n`,
      );
    });
}

// ── Startup ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  connectToServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write(`autonomos-channel: started (session=${SESSION_ID})\n`);
}

main().catch((err) => {
  process.stderr.write(`autonomos-channel: fatal: ${err}\n`);
  process.exit(1);
});

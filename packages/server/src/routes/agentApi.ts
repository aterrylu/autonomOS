/**
 * The REST surface an agent's channel server may call with its PER-AGENT token.
 *
 * Security audit V3: every agent used to carry the OPERATOR token (in argv,
 * where other local users can read it with `ps`, and in its env) because the
 * channel server's MCP tools called the public API with it. Now the channel
 * server calls these routes over the internal socket (0600, same-user) with
 * `X-Agent-Session` + `X-Agent-Token`, and no agent is given the operator
 * token at all.
 *
 * Shape, and why:
 * - A SEPARATE router holding ONLY the allowlisted method + route pairs, mounted
 *   on the internal app. The agent credential is accepted nowhere else: not on
 *   the public listener (whose auth stays operator-only), not on `/mcp`, and
 *   not on anything added to the internal app later.
 * - The allowlist is Hono's own route match, not a string test on the path, so
 *   `/api/agents/`, `//api/agents` or `/api/%61gents` simply match nothing.
 *   The router is strict (a trailing slash is a different path).
 * - Each entry forwards to the SAME router the public API mounts, so there is
 *   one implementation of every handler. The forward runs inside `runAsAgent`,
 *   which is how a handler learns the caller is an agent (see callerContext).
 * - Every call is logged with the agent that made it: distinguishing agent
 *   from operator is the point of this change, and the log is where that shows.
 *
 * Deliberately NOT here (so an agent credential can't reach them): every
 * operator-only system route, settings, providers, usage, the scheduler's
 * status/settings controls, reads of a single env preset or template, and
 * anything the dashboard alone uses.
 */

import type { Context, Hono as HonoApp, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { verifyAgentToken } from "../agentCredentials.js";
import { getAgent } from "../agents/store.js";
import { runAsAgent } from "../callerContext.js";
import { agentsRouter } from "./agents.js";
import { envPresetRouter } from "./env-presets.js";
import { scheduleRouter } from "./schedules.js";
import { templateRouter } from "./templates.js";

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** One allowlisted call: the route as the channel server uses it, the router
 *  that implements it, and the router's own prefix under /api. */
interface Entry {
  method: Method;
  path: string;
  router: HonoApp;
  base: string;
}

// The exact set the channel server's MCP tools call (channel-server/index.ts
// serverFetch sites). Adding a tool that needs a new route means adding it here
// on purpose, where a reviewer sees it.
export const AGENT_API_ROUTES: readonly Entry[] = [
  { method: "POST", path: "/agents", router: agentsRouter, base: "/agents" },
  {
    method: "GET",
    path: "/agents/tree",
    router: agentsRouter,
    base: "/agents",
  },
  {
    method: "POST",
    path: "/agents/:id/kill",
    router: agentsRouter,
    base: "/agents",
  },
  {
    method: "POST",
    path: "/agents/:id/manager",
    router: agentsRouter,
    base: "/agents",
  },
  {
    method: "GET",
    path: "/templates",
    router: templateRouter,
    base: "/templates",
  },
  {
    method: "POST",
    path: "/templates",
    router: templateRouter,
    base: "/templates",
  },
  {
    method: "GET",
    path: "/env-presets",
    router: envPresetRouter,
    base: "/env-presets",
  },
  {
    method: "POST",
    path: "/env-presets",
    router: envPresetRouter,
    base: "/env-presets",
  },
  {
    method: "PUT",
    path: "/env-presets/:name",
    router: envPresetRouter,
    base: "/env-presets",
  },
  {
    method: "DELETE",
    path: "/env-presets/:name",
    router: envPresetRouter,
    base: "/env-presets",
  },
  {
    method: "GET",
    path: "/schedules",
    router: scheduleRouter,
    base: "/schedules",
  },
  {
    method: "POST",
    path: "/schedules",
    router: scheduleRouter,
    base: "/schedules",
  },
  {
    method: "GET",
    path: "/schedules/:name",
    router: scheduleRouter,
    base: "/schedules",
  },
  {
    method: "PUT",
    path: "/schedules/:name",
    router: scheduleRouter,
    base: "/schedules",
  },
  {
    method: "DELETE",
    path: "/schedules/:name",
    router: scheduleRouter,
    base: "/schedules",
  },
  {
    method: "POST",
    path: "/schedules/:name/run",
    router: scheduleRouter,
    base: "/schedules",
  },
];

export const AGENT_SESSION_HEADER = "X-Agent-Session";
export const AGENT_TOKEN_HEADER = "X-Agent-Token";

/** The verified agent session behind a request, or null. */
export function verifiedAgentSession(c: Context): string | null {
  const sessionId = c.req.header(AGENT_SESSION_HEADER);
  if (!sessionId) return null;
  return verifyAgentToken(sessionId, c.req.header(AGENT_TOKEN_HEADER))
    ? sessionId
    : null;
}

/** Re-issue the request against `router`, with the path made relative to its
 *  mount point (`/api/agents/x/kill` → `/x/kill`). Query string kept. */
function forward(c: Context, entry: Entry): Promise<Response> | Response {
  const url = new URL(c.req.url);
  const prefix = `/api${entry.base}`;
  const rest = url.pathname.slice(prefix.length) || "/";
  url.pathname = rest;
  return entry.router.fetch(new Request(url, c.req.raw), c.env);
}

/** The router to mount at `/api` on the internal app. */
export function createAgentApi(): Hono {
  const api = new Hono({ strict: true });

  // Auth sits in each allowlisted handler, NOT in a `use("*")`: this router is
  // mounted at /api on the internal app, where a wildcard middleware would
  // also run for /api/hooks and 401 every hook relay.
  for (const entry of AGENT_API_ROUTES) {
    api.on(entry.method, entry.path, async (c) => {
      const sessionId = verifiedAgentSession(c);
      if (!sessionId) {
        return c.json(
          { error: "Unauthorized: agent credential required" },
          401,
        );
      }
      const res = await runAsAgent({ kind: "agent", sessionId }, () =>
        forward(c, entry),
      );
      if (entry.method !== "GET") {
        const name = getAgent(sessionId)?.name ?? "unknown";
        console.log(
          `[agent-api] ${JSON.stringify(name)} (${sessionId.slice(0, 8)}) ${entry.method} ${new URL(c.req.url).pathname} → ${res.status}`,
        );
      }
      return res;
    });
  }

  return api;
}

/**
 * Upgrade auth for /ws/gateway on the internal app: the per-agent credential
 * (what a channel server from this version sends), else the operator check it
 * always had, so a channel server from before this change keeps connecting
 * until its agent respawns. The register frame still proves the session.
 */
export function gatewayUpgradeAuth(
  operatorAuth: MiddlewareHandler,
): MiddlewareHandler {
  return (c, next) =>
    verifiedAgentSession(c) ? next() : operatorAuth(c, next);
}

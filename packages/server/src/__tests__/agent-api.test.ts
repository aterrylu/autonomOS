import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import WebSocket from "ws";
import {
  _resetAgentCredentialsForTesting,
  mintAgentToken,
} from "../agentCredentials.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { getEnvPresetRaw } from "../envPresets.js";
import { isSessionClientRegistered } from "../gateway/router.js";
import {
  AGENT_API_ROUTES,
  createAgentApi,
  gatewayUpgradeAuth,
} from "../routes/agentApi.js";
import { envPresetRouter } from "../routes/env-presets.js";
import { gatewayRouter } from "../routes/gateway.js";
import { waitUntil } from "./helpers/wait.js";

/**
 * The per-agent REST surface on the internal socket (security audit V3).
 *
 * The channel server's MCP tools used to call the public API with the OPERATOR
 * token, so every agent held it. Now they call routes/agentApi.ts with their
 * per-agent credential. The review asked for four properties, each pinned here:
 *   1. the allowlist is enforced by the route MATCH, so path variants reach
 *      nothing;
 *   2. an agent credential reaches nothing outside the allowlist, and the
 *      router doesn't break its neighbours on the internal app (/api/hooks);
 *   3. agent writes are attributed in the log;
 *   4. an agent can't write env-preset secret values, even calling the REST
 *      route directly.
 */

const SESSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
let token: string;
let otherToken: string;
let dir: string;

/** The internal app as run.ts builds it, plus stand-ins for its neighbours. */
function internalApp(): Hono {
  const app = new Hono();
  // The agent API is mounted FIRST here, the order where a wildcard middleware
  // on it would intercept its neighbours. run.ts mounts /api/hooks first, which
  // would hide that bug; the property must not depend on mount order.
  app.route("/api", createAgentApi());
  app.post("/api/hooks/:id", (c) => c.json({ hook: c.req.param("id") }));
  app.get("/mcp", (c) => c.text("mcp"));
  return app;
}

function asAgent(session = SESSION, tok = token): Record<string, string> {
  return { "X-Agent-Session": session, "X-Agent-Token": tok };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "aos-agent-api-"));
  _setConfigDirForTesting(dir);
  token = mintAgentToken(SESSION);
  otherToken = mintAgentToken(OTHER);
});

after(() => {
  _resetAgentCredentialsForTesting();
  _resetConfigDirForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe("agent API authentication", () => {
  const app = internalApp();

  it("serves an allowlisted route to a valid agent credential", async () => {
    for (const path of [
      "/api/templates",
      "/api/env-presets",
      "/api/schedules",
      "/api/agents/tree",
    ]) {
      const res = await app.request(path, { headers: asAgent() });
      assert.equal(res.status, 200, `${path} → ${res.status}`);
    }
  });

  it("refuses a missing, wrong, or someone-else's credential", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["no headers", {}],
      ["token only", { "X-Agent-Token": token }],
      ["wrong token", asAgent(SESSION, "not-the-token")],
      ["OTHER's token claiming SESSION", asAgent(SESSION, otherToken)],
      [
        "unknown session",
        asAgent("cccccccc-3333-4333-8333-cccccccccccc", token),
      ],
    ];
    for (const [label, headers] of cases) {
      const res = await app.request("/api/templates", { headers });
      assert.equal(res.status, 401, label);
    }
  });

  it("does not accept the operator's Bearer header in place of an agent credential", async () => {
    const res = await app.request("/api/templates", {
      headers: { Authorization: "Bearer anything" },
    });
    assert.equal(res.status, 401);
  });
});

describe("agent API allowlist is the route match (review hole 1)", () => {
  const app = internalApp();

  it("path variants of allowlisted routes reach nothing", async () => {
    for (const path of [
      "/api/templates/",
      "//api/templates",
      "/api/%74emplates",
      "/api/agents/tree/",
      "/api/agents/x/kill/",
      "/api//agents/tree",
    ]) {
      const method = path.includes("kill") ? "POST" : "GET";
      const res = await app.request(path, { method, headers: asAgent() });
      assert.equal(res.status, 404, `${method} ${path} → ${res.status}`);
    }
  });

  it("OPTIONS reaches nothing; HEAD only mirrors an allowlisted GET", async () => {
    assert.equal(
      (
        await app.request("/api/templates", {
          method: "OPTIONS",
          headers: asAgent(),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await app.request("/api/templates", {
          method: "HEAD",
          headers: asAgent(),
        })
      ).status,
      200,
    );
    // POST-only route: HEAD must not reach it.
    assert.equal(
      (
        await app.request("/api/agents/x/kill", {
          method: "HEAD",
          headers: asAgent(),
        })
      ).status,
      404,
    );
  });

  it("routes outside the allowlist are unreachable with an agent credential", async () => {
    const unlisted: Array<[string, string]> = [
      ["GET", "/api/agents"],
      ["GET", "/api/agents/x"],
      ["DELETE", "/api/agents/x"],
      ["GET", "/api/templates/x"],
      ["DELETE", "/api/templates/x"],
      ["GET", "/api/env-presets/x"],
      ["GET", "/api/schedules/x/runs"],
      ["GET", "/api/settings"],
      ["PUT", "/api/settings"],
      ["GET", "/api/providers"],
      ["POST", "/api/system/update"],
      ["POST", "/api/system/restart"],
      ["GET", "/api/plugins/claude-usage/usage"],
    ];
    for (const [method, path] of unlisted) {
      const res = await app.request(path, { method, headers: asAgent() });
      assert.equal(res.status, 404, `${method} ${path} → ${res.status}`);
    }
  });

  it("the scheduler's control routes aren't reachable through the :name route", async () => {
    // /api/schedules/status is the scheduler's status route on the public API.
    // Here it can only resolve as a schedule NAMED "status", which is reserved.
    const res = await app.request("/api/schedules/status", {
      headers: asAgent(),
    });
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes("maxConcurrentRuns"), body);
  });

  it("leaves its neighbours on the internal app alone (no wildcard middleware)", async () => {
    // /api/hooks has its own auth; an agent-API middleware on "/api/*" would
    // 401 every hook relay.
    const hook = await app.request(`/api/hooks/${SESSION}`, { method: "POST" });
    assert.equal(hook.status, 200);
    assert.equal((await app.request("/mcp")).status, 200);
  });

  it("the allowlist is exactly the channel server's tool routes", () => {
    assert.deepEqual(
      AGENT_API_ROUTES.map((r) => `${r.method} ${r.path}`).sort(),
      [
        "DELETE /env-presets/:name",
        "DELETE /schedules/:name",
        "GET /agents/tree",
        "GET /env-presets",
        "GET /schedules",
        "GET /schedules/:name",
        "GET /templates",
        "POST /agents",
        "POST /agents/:id/kill",
        "POST /agents/:id/manager",
        "POST /env-presets",
        "POST /schedules",
        "POST /schedules/:name/run",
        "POST /templates",
        "PUT /env-presets/:name",
        "PUT /schedules/:name",
      ],
    );
  });
});

describe("agent API writes", () => {
  const app = internalApp();

  it("an agent can't write an env-preset secret value, even via REST (review hole 4)", async () => {
    const res = await app.request("/api/env-presets", {
      method: "POST",
      headers: { ...asAgent(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "agent-preset",
        secretKeys: ["API_KEY"],
        secrets: { API_KEY: "sk-agent-canary" },
      }),
    });
    assert.equal(res.status, 201, await res.clone().text());
    const raw = getEnvPresetRaw("agent-preset");
    assert.ok(raw, "precondition: the preset was created");
    assert.deepEqual(raw.secretKeys, ["API_KEY"]);
    assert.equal(raw.secrets?.API_KEY, undefined);
  });

  it("an agent PUT can't set or blank a secret the human set", async () => {
    // The human path (no agent context) keys it in.
    const human = await envPresetRouter.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "human-preset",
        secretKeys: ["API_KEY"],
        secrets: { API_KEY: "sk-human-real" },
      }),
    });
    assert.equal(human.status, 201);
    assert.equal(
      getEnvPresetRaw("human-preset")?.secrets?.API_KEY,
      "sk-human-real",
    );

    for (const value of ["sk-agent-override", ""]) {
      const res = await app.request("/api/env-presets/human-preset", {
        method: "PUT",
        headers: { ...asAgent(), "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { API_KEY: value } }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(
        getEnvPresetRaw("human-preset")?.secrets?.API_KEY,
        "sk-human-real",
        `agent PUT with ${JSON.stringify(value)} changed the secret`,
      );
    }
  });

  it("logs which agent made a write (review hole 3)", async () => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await app.request("/api/templates", {
        method: "POST",
        headers: { ...asAgent(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "t-attrib", role: "worker" }),
      });
    } finally {
      console.log = real;
    }
    assert.ok(
      lines.some(
        (l) =>
          l.includes("[agent-api]") &&
          l.includes(SESSION.slice(0, 8)) &&
          l.includes("POST /api/templates"),
      ),
      `no attribution line in:\n${lines.join("\n")}`,
    );
  });
});

describe("/ws/gateway upgrade accepts the agent credential (and still the operator token)", () => {
  const GOOD = "operator-token-for-old-channel-servers";
  const sockDir = mkdtempSync(join(tmpdir(), "aos-gwup-"));
  const sock = join(sockDir, "c.sock");
  let server: Server;

  // Mirrors the query-token branch of run.ts's requireAuth, which is all a
  // pre-change channel server's `?token=` upgrade can exercise.
  const operatorAuth: MiddlewareHandler = async (c, next) =>
    c.req.query("token") === GOOD
      ? next()
      : c.json({ error: "Unauthorized" }, 401);

  before(async () => {
    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.use("/ws/gateway", gatewayUpgradeAuth(operatorAuth));
    app.get("/ws/gateway", gatewayRouter(upgradeWebSocket));
    server = createAdaptorServer({ fetch: app.fetch }) as Server;
    injectWebSocket(server);
    await new Promise<void>((r) => server.listen(sock, r));
  });

  after(() => {
    server?.close();
    rmSync(sockDir, { recursive: true, force: true });
  });

  /** Connect, register as SESSION, and report whether the gateway accepted it. */
  async function tryConnect(opts: {
    query?: string;
    headers?: Record<string, string>;
  }): Promise<"registered" | "refused"> {
    // Precondition: the previous case's registration is gone, or "registered"
    // below could be left over from it.
    await waitUntil(
      () => !isSessionClientRegistered(SESSION),
      "previous registration to clear",
    );
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `ws+unix://${sock}:/ws/gateway${opts.query ?? ""}`,
        {
          headers: opts.headers,
        },
      );
      ws.on("unexpected-response", () => resolve("refused"));
      ws.on("error", () => resolve("refused"));
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "register",
            sessionId: SESSION,
            agentToken: token,
          }),
        );
        setTimeout(() => {
          const ok = isSessionClientRegistered(SESSION);
          ws.close();
          resolve(ok ? "registered" : "refused");
        }, 200);
      });
    });
  }

  it("a new channel server: agent headers, no operator token", async () => {
    assert.equal(await tryConnect({ headers: asAgent() }), "registered");
  });

  it("an old channel server: operator ?token= still works (upgrade window)", async () => {
    assert.equal(await tryConnect({ query: `?token=${GOOD}` }), "registered");
  });

  it("neither credential: the upgrade is refused", async () => {
    assert.equal(await tryConnect({}), "refused");
    assert.equal(
      await tryConnect({ headers: asAgent(SESSION, "wrong") }),
      "refused",
    );
  });
});

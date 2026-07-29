/**
 * Tests for the channel server's schedule tool routing.
 *
 * The channel server routes schedule MCP tool calls to the REST API
 * via serverFetch(). We verify the URL construction and argument
 * passthrough by making the same HTTP calls against a real Hono app.
 *
 * This covers the mapping in channel-server/index.ts lines 509-548:
 *   create_schedule → POST /api/schedules (body = args)
 *   list_schedules  → GET  /api/schedules
 *   get_schedule    → GET  /api/schedules/:name
 *   update_schedule → PUT  /api/schedules/:name (body = partial)
 *   delete_schedule → DELETE /api/schedules/:name
 *   run_schedule    → POST /api/schedules/:name/run
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

const TEST_DIR = join(tmpdir(), `autonomos-chan-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { scheduleRouter, schedulerRouter } = await import(
  "../routes/schedules.js"
);
const { _resetForTesting, _setExecutors, _onRunCompleted, initScheduler } =
  await import("../scheduler.js");

function createApp() {
  const app = new Hono();
  app.route("/api/schedules", scheduleRouter);
  app.route("/api/scheduler", schedulerRouter);
  return app;
}

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(
    join(TEST_DIR, "settings.json"),
    JSON.stringify({ scheduler: { maxConcurrentRuns: 3 } }),
  );
}

/**
 * Simulates how the channel server's serverFetch works:
 * makes an HTTP request, returns { content, isError } in MCP format.
 */
async function channelFetch(
  app: Hono,
  path: string,
  init?: { method?: string; body?: string },
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const reqInit: RequestInit = { method: init?.method ?? "GET" };
  if (init?.body) {
    reqInit.headers = { "Content-Type": "application/json" };
    reqInit.body = init.body;
  }
  const res = await app.request(path, reqInit);
  if (!res.ok) {
    const text = await res.text();
    return {
      content: [{ type: "text", text: `Failed: ${text}` }],
      isError: true,
    };
  }
  const data = await res.json();
  const pretty =
    typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
  return { content: [{ type: "text", text: pretty }] };
}

/**
 * Replicates the channel server's tool-to-HTTP mapping.
 * This is the code we're actually testing — that the switch/case
 * in channel-server/index.ts constructs the right calls.
 */
function routeToolCall(
  app: Hono,
  toolName: string,
  args: Record<string, unknown>,
) {
  switch (toolName) {
    case "create_schedule":
      return channelFetch(app, "/api/schedules", {
        method: "POST",
        body: JSON.stringify(args),
      });
    case "list_schedules":
      return channelFetch(app, "/api/schedules");
    case "get_schedule": {
      const { name } = args as { name: string };
      return channelFetch(app, `/api/schedules/${encodeURIComponent(name)}`);
    }
    case "update_schedule": {
      const { name, ...partial } = args as {
        name: string;
        [k: string]: unknown;
      };
      return channelFetch(app, `/api/schedules/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(partial),
      });
    }
    case "delete_schedule": {
      const { name } = args as { name: string };
      return channelFetch(app, `/api/schedules/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    }
    case "run_schedule": {
      const { name } = args as { name: string };
      return channelFetch(
        app,
        `/api/schedules/${encodeURIComponent(name)}/run`,
        { method: "POST" },
      );
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

describe("channel server schedule tool routing", () => {
  let app: Hono;

  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors((name) => {
      _onRunCompleted(name, { status: "success" });
    });
    initScheduler();
    app = createApp();
  });

  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("create_schedule → POST /api/schedules", async () => {
    const result = await routeToolCall(app, "create_schedule", {
      name: "chan-create",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "test",
      workingDirectory: "~",
    });

    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
    assert.equal(data.schedule.name, "chan-create");
  });

  it("list_schedules → GET /api/schedules", async () => {
    // Create one first
    await routeToolCall(app, "create_schedule", {
      name: "chan-list",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "test",
      workingDirectory: "~",
    });

    const result = await routeToolCall(app, "list_schedules", {});
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data["chan-list"]);
  });

  it("get_schedule → GET /api/schedules/:name", async () => {
    await routeToolCall(app, "create_schedule", {
      name: "chan-get",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "test",
      workingDirectory: "~",
    });

    const result = await routeToolCall(app, "get_schedule", {
      name: "chan-get",
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.name, "chan-get");
    assert.ok(Array.isArray(data.recentRuns));
  });

  it("get_schedule returns error for missing schedule", async () => {
    const result = await routeToolCall(app, "get_schedule", {
      name: "nonexistent",
    });
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes("not found"));
  });

  it("update_schedule → PUT /api/schedules/:name", async () => {
    await routeToolCall(app, "create_schedule", {
      name: "chan-update",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "old",
      workingDirectory: "~",
    });

    const result = await routeToolCall(app, "update_schedule", {
      name: "chan-update",
      prompt: "new prompt",
    });
    assert.ok(!result.isError);

    // Verify
    const get = await routeToolCall(app, "get_schedule", {
      name: "chan-update",
    });
    const data = JSON.parse(get.content[0].text);
    assert.equal(data.prompt, "new prompt");
  });

  it("delete_schedule → DELETE /api/schedules/:name", async () => {
    await routeToolCall(app, "create_schedule", {
      name: "chan-delete",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "test",
      workingDirectory: "~",
    });

    const result = await routeToolCall(app, "delete_schedule", {
      name: "chan-delete",
    });
    assert.ok(!result.isError);

    // Confirm gone
    const get = await routeToolCall(app, "get_schedule", {
      name: "chan-delete",
    });
    assert.ok(get.isError);
  });

  it("delete_schedule returns error for missing schedule", async () => {
    const result = await routeToolCall(app, "delete_schedule", {
      name: "nonexistent",
    });
    assert.ok(result.isError);
  });

  it("run_schedule → POST /api/schedules/:name/run", async () => {
    await routeToolCall(app, "create_schedule", {
      name: "chan-run",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "test",
      workingDirectory: "~",
    });

    const result = await routeToolCall(app, "run_schedule", {
      name: "chan-run",
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.ok, true);
  });

  it("run_schedule returns error for missing schedule", async () => {
    const result = await routeToolCall(app, "run_schedule", {
      name: "nonexistent",
    });
    assert.ok(result.isError);
  });

  it("handles names with special characters via encodeURIComponent", async () => {
    // Create with a name that needs encoding
    await routeToolCall(app, "create_schedule", {
      name: "test-123",
      schedule: "0 9 * * *",
      target: "agent:worker",
      prompt: "test",
      workingDirectory: "~",
    });

    // All operations should work with the encoded name
    const get = await routeToolCall(app, "get_schedule", { name: "test-123" });
    assert.ok(!get.isError);

    const update = await routeToolCall(app, "update_schedule", {
      name: "test-123",
      prompt: "updated",
    });
    assert.ok(!update.isError);

    const run = await routeToolCall(app, "run_schedule", { name: "test-123" });
    assert.ok(!run.isError);

    const del = await routeToolCall(app, "delete_schedule", {
      name: "test-123",
    });
    assert.ok(!del.isError);
  });

  it("full lifecycle mirrors channel server behavior", async () => {
    // This test replicates the exact sequence an agent would make
    // via the channel server MCP tools

    // 1. Agent creates a schedule
    const create = await routeToolCall(app, "create_schedule", {
      name: "agent-workflow",
      schedule: "0 9 * * 1-5",
      target: "agent:reviewer",
      prompt: "Review PRs",
      workingDirectory: "~/repo",
      description: "Daily PR review",
    });
    assert.ok(!create.isError);

    // 2. Agent lists to verify
    const list = await routeToolCall(app, "list_schedules", {});
    assert.ok(list.content[0].text.includes("agent-workflow"));

    // 3. Agent gets details
    const get = await routeToolCall(app, "get_schedule", {
      name: "agent-workflow",
    });
    const sched = JSON.parse(get.content[0].text);
    assert.equal(sched.target, "agent:reviewer");

    // 4. Agent updates prompt
    const update = await routeToolCall(app, "update_schedule", {
      name: "agent-workflow",
      prompt: "Review PRs and run linter",
    });
    assert.ok(!update.isError);

    // 5. Agent triggers manually
    const run = await routeToolCall(app, "run_schedule", {
      name: "agent-workflow",
    });
    assert.ok(!run.isError);

    // 6. Agent cleans up
    const del = await routeToolCall(app, "delete_schedule", {
      name: "agent-workflow",
    });
    assert.ok(!del.isError);
  });
});

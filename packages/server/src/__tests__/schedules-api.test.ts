import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

// ── Test isolation ─────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `autonomos-api-test-${randomUUID()}`);
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

async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await app.request(path, init);
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

const validBody = {
  name: "test-schedule",
  schedule: "0 9 * * 1-5",
  target: "isolated",
  prompt: "Run tests",
  workingDirectory: "~/workspace",
};

function setupTestDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(
    join(TEST_DIR, "settings.json"),
    JSON.stringify({ scheduler: { maxConcurrentRuns: 3 } }),
  );
}

describe("POST /api/schedules — validation", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      () => {},
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("rejects invalid JSON body", async () => {
    const app = createApp();
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "Invalid JSON body");
  });

  it("rejects missing name", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: undefined,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "name is required");
  });

  it("rejects missing schedule", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      schedule: undefined,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "schedule is required");
  });

  it("rejects missing target", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      target: undefined,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "target is required");
  });

  it("rejects missing prompt", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      prompt: undefined,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "prompt is required");
  });

  it("rejects missing workingDirectory", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      workingDirectory: undefined,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "workingDirectory is required");
  });

  it("rejects invalid target format", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      target: "webhook:foo",
    });
    assert.equal(status, 400);
    assert.ok((json.error as string).includes("Invalid target"));
  });

  it("accepts target 'isolated'", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: `test-${randomUUID().slice(0, 8)}`,
      target: "isolated",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("accepts target 'agent:<name>'", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: `test-${randomUUID().slice(0, 8)}`,
      target: "agent:my-worker",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("rejects invalid cron expression", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: `test-${randomUUID().slice(0, 8)}`,
      schedule: "not a cron",
    });
    assert.equal(status, 400);
    assert.ok((json.error as string).includes("Invalid cron expression"));
  });

  it("accepts valid one-time schedule", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: `test-${randomUUID().slice(0, 8)}`,
      schedule: `once:${future}`,
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("rejects invalid one-time date", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: `test-${randomUUID().slice(0, 8)}`,
      schedule: "once:not-a-date",
    });
    assert.equal(status, 400);
    assert.ok((json.error as string).includes("Invalid one-time date"));
  });

  it("rejects unsupported overlap policy", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name: `test-${randomUUID().slice(0, 8)}`,
      overlapPolicy: "cancel",
    });
    assert.equal(status, 400);
    assert.ok((json.error as string).includes("Unsupported overlap policy"));
  });

  it("returns 409 for duplicate name", async () => {
    const app = createApp();
    const name = `dup-${randomUUID().slice(0, 8)}`;
    await req(app, "POST", "/api/schedules", { ...validBody, name });
    const { status, json } = await req(app, "POST", "/api/schedules", {
      ...validBody,
      name,
    });
    assert.equal(status, 409);
    assert.ok((json.error as string).includes("already exists"));
  });
});

describe("POST /api/schedules — happy path", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      () => {},
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("creates schedule and returns it", async () => {
    const name = `create-${randomUUID().slice(0, 8)}`;
    const { status, json } = await req(createApp(), "POST", "/api/schedules", {
      ...validBody,
      name,
      description: "A test schedule",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.schedule);
    const schedule = json.schedule as Record<string, unknown>;
    assert.equal(schedule.name, name);
    assert.equal(schedule.description, "A test schedule");
  });
});

describe("GET /api/schedules", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      () => {},
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns empty object when no schedules", async () => {
    const { status, json } = await req(createApp(), "GET", "/api/schedules");
    assert.equal(status, 200);
    assert.deepEqual(json, {});
  });

  it("returns all schedules", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "list-a",
    });
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "list-b",
    });

    const { status, json } = await req(app, "GET", "/api/schedules");
    assert.equal(status, 200);
    assert.ok(json["list-a"]);
    assert.ok(json["list-b"]);
  });
});

describe("GET /api/schedules/:name", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      () => {},
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns 404 for unknown schedule", async () => {
    const { status, json } = await req(
      createApp(),
      "GET",
      "/api/schedules/nonexistent",
    );
    assert.equal(status, 404);
    assert.ok((json.error as string).includes("not found"));
  });

  it("returns schedule with recent runs", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "get-test",
    });

    const { status, json } = await req(app, "GET", "/api/schedules/get-test");
    assert.equal(status, 200);
    assert.equal(json.name, "get-test");
    assert.ok(Array.isArray(json.recentRuns));
  });

  it("returns 400 for invalid name", async () => {
    const { status, json } = await req(
      createApp(),
      "GET",
      "/api/schedules/INVALID_NAME",
    );
    assert.equal(status, 400);
    assert.ok((json.error as string).includes("Invalid schedule name"));
  });
});

describe("PUT /api/schedules/:name", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      () => {},
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("updates schedule fields", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "update-me",
    });

    const { status, json } = await req(app, "PUT", "/api/schedules/update-me", {
      prompt: "New prompt",
      description: "Updated",
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const schedule = json.schedule as Record<string, unknown>;
    assert.equal(schedule.prompt, "New prompt");
    assert.equal(schedule.description, "Updated");
  });

  it("returns 404 for unknown schedule", async () => {
    const { status, json } = await req(
      createApp(),
      "PUT",
      "/api/schedules/ghost",
      { prompt: "nope" },
    );
    assert.equal(status, 404);
    assert.ok((json.error as string).includes("not found"));
  });

  it("rejects invalid JSON body", async () => {
    const app = createApp();
    const res = await app.request("/api/schedules/whatever", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "Invalid JSON body");
  });

  it("rejects unsupported overlap policy on update", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "update-policy",
    });

    const { status, json } = await req(
      app,
      "PUT",
      "/api/schedules/update-policy",
      { overlapPolicy: "cancel" },
    );
    assert.equal(status, 400);
    assert.ok((json.error as string).includes("Unsupported overlap policy"));
  });
});

describe("DELETE /api/schedules/:name", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      () => {},
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("deletes existing schedule", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "delete-me",
    });

    const { status, json } = await req(
      app,
      "DELETE",
      "/api/schedules/delete-me",
    );
    assert.equal(status, 200);
    assert.equal(json.ok, true);

    // Confirm it's gone
    const { status: getStatus } = await req(
      app,
      "GET",
      "/api/schedules/delete-me",
    );
    assert.equal(getStatus, 404);
  });

  it("returns 404 for unknown schedule", async () => {
    const { status, json } = await req(
      createApp(),
      "DELETE",
      "/api/schedules/nonexistent",
    );
    assert.equal(status, 404);
    assert.ok((json.error as string).includes("not found"));
  });
});

describe("POST /api/schedules/:name/run", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      (name) => {
        _onRunCompleted(name, { status: "success" });
      },
      (name) => {
        _onRunCompleted(name, { status: "success" });
      },
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("triggers schedule immediately", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "run-now",
    });

    const { status, json } = await req(
      app,
      "POST",
      "/api/schedules/run-now/run",
    );
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("returns 404 for unknown schedule", async () => {
    const { status } = await req(
      createApp(),
      "POST",
      "/api/schedules/ghost/run",
    );
    assert.equal(status, 404);
  });
});

describe("GET /api/schedules/:name/runs", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    _setExecutors(
      (name) => {
        _onRunCompleted(name, { status: "success" });
      },
      () => {},
    );
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns run history", async () => {
    const app = createApp();
    await req(app, "POST", "/api/schedules", {
      ...validBody,
      name: "run-history",
    });
    // Trigger a run
    await req(app, "POST", "/api/schedules/run-history/run");

    const { status, json } = await req(
      app,
      "GET",
      "/api/schedules/run-history/runs",
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(json));
    assert.ok((json as unknown[]).length >= 1);
  });
});

describe("GET /api/scheduler/status", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns scheduler status", async () => {
    const { status, json } = await req(
      createApp(),
      "GET",
      "/api/scheduler/status",
    );
    assert.equal(status, 200);
    assert.equal(json.running, true);
    assert.equal(typeof json.maxConcurrentRuns, "number");
    assert.equal(typeof json.activeRuns, "number");
    assert.equal(typeof json.queuedRuns, "number");
  });
});

describe("PUT /api/scheduler/settings", () => {
  beforeEach(() => {
    setupTestDir();
    _resetForTesting();
    initScheduler();
  });
  afterEach(() => {
    _resetForTesting();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("updates maxConcurrentRuns", async () => {
    const { status, json } = await req(
      createApp(),
      "PUT",
      "/api/scheduler/settings",
      { maxConcurrentRuns: 5 },
    );
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.maxConcurrentRuns, 5);
  });

  it("rejects non-positive maxConcurrentRuns", async () => {
    const { status, json } = await req(
      createApp(),
      "PUT",
      "/api/scheduler/settings",
      { maxConcurrentRuns: 0 },
    );
    assert.equal(status, 400);
    assert.ok(
      (json.error as string).includes("maxConcurrentRuns must be a positive"),
    );
  });

  it("rejects non-number maxConcurrentRuns", async () => {
    const { status, json } = await req(
      createApp(),
      "PUT",
      "/api/scheduler/settings",
      { maxConcurrentRuns: "five" },
    );
    assert.equal(status, 400);
  });

  it("rejects invalid JSON body", async () => {
    const app = createApp();
    const res = await app.request("/api/scheduler/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "bad{",
    });
    assert.equal(res.status, 400);
    const json = (await res.json()) as { error: string };
    assert.equal(json.error, "Invalid JSON body");
  });
});

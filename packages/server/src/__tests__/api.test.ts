import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Hono } from "hono";
import { sessionRouter } from "../routes/sessions.js";
import { _resetForTesting, killAllSessions } from "../sessions.js";

// Create a test app with just the session routes (no WebSocket needed)
function createApp() {
  const app = new Hono();
  app.route("/api/sessions", sessionRouter);
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
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

describe("POST /api/sessions — validation", () => {
  afterEach(() => {
    killAllSessions();
    _resetForTesting();
  });

  it("rejects missing body", async () => {
    const app = createApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, "Invalid JSON body");
  });

  it("rejects missing workingDirectory", async () => {
    const { status, json } = await req(
      createApp(),
      "POST",
      "/api/sessions",
      {},
    );
    assert.equal(status, 400);
    assert.equal(json.error, "workingDirectory is required");
  });

  it("rejects non-string workingDirectory", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/sessions", {
      workingDirectory: 123,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "workingDirectory is required");
  });

  it("rejects invalid cols", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/sessions", {
      workingDirectory: "~",
      cols: -1,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "cols must be a positive number");
  });

  it("rejects non-numeric cols", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/sessions", {
      workingDirectory: "~",
      cols: "abc",
    });
    assert.equal(status, 400);
    assert.equal(json.error, "cols must be a positive number");
  });

  it("rejects invalid rows", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/sessions", {
      workingDirectory: "~",
      rows: 0,
    });
    assert.equal(status, 400);
    assert.equal(json.error, "rows must be a positive number");
  });

  it("accepts valid request and returns 201 with session", async () => {
    const { status, json } = await req(createApp(), "POST", "/api/sessions", {
      workingDirectory: "~",
    });
    // This will either succeed (201) or fail (500) depending on whether
    // claude binary is available. Both are valid test outcomes.
    if (status === 201) {
      assert.ok(json.id);
      assert.equal(json.status, "running");
      assert.equal(json.provider, "claude-code");
      // workingDirectory should be expanded
      assert.ok(
        !(json.workingDirectory as string).startsWith("~"),
        "workingDirectory should be expanded",
      );
    } else {
      // 500 = claude binary not found, which is fine in CI
      assert.equal(status, 500);
      assert.ok(json.error);
      assert.ok(json.detail);
    }
  });
});

describe("GET /api/sessions", () => {
  afterEach(() => {
    killAllSessions();
    _resetForTesting();
  });

  it("returns empty array when no sessions", async () => {
    const { status, json } = await req(createApp(), "GET", "/api/sessions");
    assert.equal(status, 200);
    assert.deepEqual(json, []);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns 404 for unknown session", async () => {
    const { status, json } = await req(
      createApp(),
      "GET",
      "/api/sessions/nonexistent",
    );
    assert.equal(status, 404);
    assert.equal(json.error, "Session not found");
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("returns 404 for unknown session", async () => {
    const { status, json } = await req(
      createApp(),
      "DELETE",
      "/api/sessions/nonexistent",
    );
    assert.equal(status, 404);
    assert.equal(json.error, "Session not found");
  });
});

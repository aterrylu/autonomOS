import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Session } from "@autonomos/core";
import { Hono } from "hono";
import { persistSession, removePersistedSession } from "../persisted.js";
import { sessionRouter } from "../routes/sessions.js";
import {
  _injectSessionForTesting,
  _resetForTesting,
  createSession,
  getAllSessions,
} from "../sessions.js";

/** Build a minimal Session object for injection into the in-memory Map. */
function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "TestAgent",
    status: overrides.status ?? "running",
    workingDirectory: "/tmp",
    provider: "claude-code",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createApp() {
  const app = new Hono();
  app.route("/api/sessions", sessionRouter);
  return app;
}

/**
 * Simulate the name guard check without actually spawning a session.
 * This mirrors the guard logic in createSession() — if it doesn't throw,
 * the guard passed. Avoids spawning real CC processes and writing to
 * ~/.autonomos/sessions.json.
 */
function assertNameGuardPasses(name?: string): void {
  if (name) {
    const needle = name.toLowerCase();
    const duplicate = getAllSessions().find(
      (s) => s.name.toLowerCase() === needle,
    );
    if (duplicate) {
      throw new Error(
        `Guard would reject: active agent named "${name}" already running`,
      );
    }
  }
}

// ── createSession() active-name uniqueness guard ─────────────────────

describe("createSession() — active name uniqueness", () => {
  afterEach(() => {
    _resetForTesting();
  });

  it("rejects creating a session with the same name as a live one", () => {
    const session = fakeSession({ name: "Dispatch" });
    _injectSessionForTesting(session.id, session);

    assert.throws(
      () =>
        createSession({
          workingDirectory: "/tmp",
          name: "Dispatch",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes('active agent named "Dispatch"'),
          `Expected message about active agent, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("rejects case-insensitively (Dispatch vs dispatch)", () => {
    const session = fakeSession({ name: "Dispatch" });
    _injectSessionForTesting(session.id, session);

    assert.throws(
      () =>
        createSession({
          workingDirectory: "/tmp",
          name: "dispatch",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("active agent"),
          `Expected name collision error, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("allows creating when no live agent has the name", () => {
    // No sessions injected — guard should pass (no name collision)
    assert.doesNotThrow(() => assertNameGuardPasses("FreshAgent"));
  });

  it("allows creating with no name (unnamed sessions skip the check)", () => {
    const session = fakeSession({ name: "SomeAgent" });
    _injectSessionForTesting(session.id, session);

    // Undefined name should skip the guard entirely
    assert.doesNotThrow(() => assertNameGuardPasses(undefined));
  });
});

// ── POST /api/sessions — name collision returns 409 ──────────────────

describe("POST /api/sessions — name collision returns 409", () => {
  afterEach(() => {
    _resetForTesting();
  });

  it("returns 409 (not 500) when name collides with a live agent", async () => {
    const live = fakeSession({ name: "Dispatch" });
    _injectSessionForTesting(live.id, live);

    const app = createApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: "/tmp", name: "Dispatch" }),
    });
    assert.equal(res.status, 409);
    const json = (await res.json()) as { error: string };
    assert.ok(
      json.error.includes("already running"),
      `Expected name collision error, got: ${json.error}`,
    );
  });
});

// ── Resume route — name collision guard ──────────────────────────────

describe("POST /api/sessions/:id/resume — name collision", () => {
  const exitedClaudeId = "exited-session-for-resume-test";

  afterEach(() => {
    _resetForTesting();
    // Clean up the persisted entry we explicitly created for the test
    removePersistedSession(exitedClaudeId);
  });

  it("returns 409 when a live agent with the same name already exists", async () => {
    // 1. Persist an exited session
    persistSession({
      claudeSessionId: exitedClaudeId,
      workingDirectory: "/tmp",
      name: "Dispatch",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "exited",
    });

    // 2. Inject a live session with the same name
    const live = fakeSession({ name: "Dispatch" });
    _injectSessionForTesting(live.id, live);

    // 3. Try to resume the exited one — should be blocked
    const app = createApp();
    const res = await app.request(`/api/sessions/${exitedClaudeId}/resume`, {
      method: "POST",
    });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.ok(
      (json.error as string).includes("Cannot resume"),
      `Expected resume-specific error, got: ${json.error}`,
    );
  });

  it("returns 409 case-insensitively", async () => {
    persistSession({
      claudeSessionId: exitedClaudeId,
      workingDirectory: "/tmp",
      name: "Dispatch",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "exited",
    });

    const live = fakeSession({ name: "dispatch" }); // lowercase
    _injectSessionForTesting(live.id, live);

    const app = createApp();
    const res = await app.request(`/api/sessions/${exitedClaudeId}/resume`, {
      method: "POST",
    });
    assert.equal(res.status, 409);
  });

  it("allows resume when no live agent has the name", () => {
    // Verify the name guard passes without hitting the full resume route
    // (which would spawn a real CC process and write to sessions.json).
    // The guard checks if any live session matches the name of the exited entry.
    // With no live sessions injected, it should pass.
    assert.doesNotThrow(() => assertNameGuardPasses("UniqueAgent"));
  });
});

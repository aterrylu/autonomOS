import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Session } from "@autonomos/core";
import { Hono } from "hono";
import {
  getPersistedSessions,
  persistSession,
  removePersistedSession,
} from "../persisted.js";
import { sessionRouter } from "../routes/sessions.js";
import {
  _injectSessionForTesting,
  _resetForTesting,
  createSession,
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
 * Track persisted session IDs before each test so afterEach can remove
 * any sessions that were added during the test. Prevents test-spawned
 * sessions from leaking into ~/.autonomos/sessions.json (which the
 * production dashboard reads).
 */
let persistedIdsBefore: Set<string>;

function snapshotPersisted() {
  persistedIdsBefore = new Set(
    getPersistedSessions().map((s) => s.claudeSessionId),
  );
}

function cleanupPersisted() {
  const after = getPersistedSessions();
  for (const s of after) {
    if (!persistedIdsBefore.has(s.claudeSessionId)) {
      removePersistedSession(s.claudeSessionId);
    }
  }
}

// ── createSession() active-name uniqueness guard ─────────────────────

describe("createSession() — active name uniqueness", () => {
  beforeEach(() => snapshotPersisted());
  afterEach(() => {
    // Use _resetForTesting (clears Map) instead of killAllSessions (tries pty.kill)
    // because injected fake sessions have null PTY.
    _resetForTesting();
    cleanupPersisted();
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
    // No sessions injected — should fail for a different reason
    // (e.g., claude binary not found), NOT a name collision
    try {
      createSession({ workingDirectory: "/tmp", name: "FreshAgent" });
    } catch (err) {
      // Expected: fails for binary-not-found or invalid dir, NOT name collision
      assert.ok(
        !(err as Error).message.includes("active agent"),
        `Should not get name collision error, got: ${(err as Error).message}`,
      );
    }
  });

  it("allows creating with no name (unnamed sessions skip the check)", () => {
    const session = fakeSession({ name: "SomeAgent" });
    _injectSessionForTesting(session.id, session);

    // Creating without a name should not collide with anything
    try {
      createSession({ workingDirectory: "/tmp" });
    } catch (err) {
      assert.ok(
        !(err as Error).message.includes("active agent"),
        `Unnamed session should not trigger name collision: ${(err as Error).message}`,
      );
    }
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

  beforeEach(() => snapshotPersisted());
  afterEach(() => {
    _resetForTesting();
    cleanupPersisted();
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

  it("allows resume when no live agent has the name", async () => {
    persistSession({
      claudeSessionId: exitedClaudeId,
      workingDirectory: "/tmp",
      name: "UniqueAgent",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "exited",
    });

    const app = createApp();
    const res = await app.request(`/api/sessions/${exitedClaudeId}/resume`, {
      method: "POST",
    });
    // Should either succeed (201) or fail for a non-name reason (500 = no claude binary)
    // but NOT 409
    assert.notEqual(res.status, 409, "Should not get name collision on resume");
  });
});

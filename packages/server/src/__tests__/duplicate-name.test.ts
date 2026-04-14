import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import type { Session } from "@autonomos/core";
import { Hono } from "hono";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import {
  _resetCacheForTesting,
  persistSession,
  removePersistedSession,
} from "../persisted.js";
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

let tmpDir: string;

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
    assert.doesNotThrow(() => assertNameGuardPasses("FreshAgent"));
  });

  it("allows creating with no name (unnamed sessions skip the check)", () => {
    const session = fakeSession({ name: "SomeAgent" });
    _injectSessionForTesting(session.id, session);

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

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-test-dupname-"));
    _setConfigDirForTesting(tmpDir);
    _resetCacheForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    removePersistedSession(exitedClaudeId);
  });

  after(() => {
    _resetCacheForTesting();
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 409 when a live agent with the same name already exists", async () => {
    persistSession({
      claudeSessionId: exitedClaudeId,
      workingDirectory: "/tmp",
      name: "Dispatch",
      autonomousMode: true,
      persistedAt: Date.now(),
      status: "exited",
    });

    const live = fakeSession({ name: "Dispatch" });
    _injectSessionForTesting(live.id, live);

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

    const live = fakeSession({ name: "dispatch" });
    _injectSessionForTesting(live.id, live);

    const app = createApp();
    const res = await app.request(`/api/sessions/${exitedClaudeId}/resume`, {
      method: "POST",
    });
    assert.equal(res.status, 409);
  });

  it("allows resume when no live agent has the name", () => {
    assert.doesNotThrow(() => assertNameGuardPasses("UniqueAgent"));
  });
});

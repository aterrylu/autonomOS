import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";

// ── Test isolation ─────────────────────────────────────────────
// Must be set before importing the route (agents store reads it on import).
process.env.AUTONOMOS_CONFIG_DIR = join(
  tmpdir(),
  `autonomos-projects-test-${randomUUID()}`,
);

const { projectRouter, _setDepsForTesting, _resetForTesting } = await import(
  "../routes/projects.js"
);

const HOME = "/Users/testuser";

interface FakeSessionSpec {
  sessionId: string;
  cwd?: string;
  summary?: string;
  customTitle?: string;
  lastModified?: number;
}

function fakeSessions(specs: FakeSessionSpec[]): SDKSessionInfo[] {
  return specs.map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    summary: s.summary ?? `session ${s.sessionId}`,
    customTitle: s.customTitle,
    lastModified: s.lastModified ?? 1700000000000,
    firstPrompt: "hello",
  })) as unknown as SDKSessionInfo[];
}

function createApp() {
  const app = new Hono();
  app.route("/api/projects", projectRouter);
  return app;
}

function setup(specs: FakeSessionSpec[]) {
  _setDepsForTesting({ listSessions: async () => fakeSessions(specs) });
  return createApp();
}

interface ProjectJson {
  path: string;
  name: string;
  lastActive: number;
  sessions: {
    sessionId: string;
    summary: string;
    customTitle?: string;
    isAutonomosAgent?: boolean;
  }[];
}

afterEach(() => {
  _resetForTesting();
});

describe("GET /api/projects — grouping & shaping", () => {
  it("groups sessions by cwd and names each project by its basename", async () => {
    const app = setup([
      { sessionId: "a", cwd: `${HOME}/workspace/autonomOS`, customTitle: "A" },
      { sessionId: "b", cwd: `${HOME}/workspace/autonomOS`, customTitle: "B" },
      { sessionId: "c", cwd: `${HOME}/workspace/other`, customTitle: "C" },
    ]);

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const projects = (await res.json()) as ProjectJson[];

    assert.equal(projects.length, 2, "two distinct cwds → two projects");
    const autonomos = projects.find(
      (p) => p.path === `${HOME}/workspace/autonomOS`,
    );
    assert.ok(autonomos);
    assert.equal(autonomos.name, "autonomOS", "name is the cwd basename");
    assert.equal(autonomos.sessions.length, 2, "both sessions grouped");
  });

  it("groups sessions with no cwd under an 'Unknown' project", async () => {
    const app = setup([{ sessionId: "a", customTitle: "A" }]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    assert.equal(projects.length, 1);
    assert.equal(projects[0].path, "unknown");
    assert.equal(projects[0].name, "Unknown");
  });

  it("sorts sessions newest-first within a project", async () => {
    const app = setup([
      {
        sessionId: "old",
        cwd: `${HOME}/workspace/p`,
        customTitle: "old",
        lastModified: 1000,
      },
      {
        sessionId: "new",
        cwd: `${HOME}/workspace/p`,
        customTitle: "new",
        lastModified: 3000,
      },
      {
        sessionId: "mid",
        cwd: `${HOME}/workspace/p`,
        customTitle: "mid",
        lastModified: 2000,
      },
    ]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    assert.deepEqual(
      projects[0].sessions.map((s) => s.sessionId),
      ["new", "mid", "old"],
    );
    assert.equal(projects[0].lastActive, 3000, "lastActive = newest session");
  });

  it("sorts projects by most-recent activity first", async () => {
    const app = setup([
      {
        sessionId: "a",
        cwd: `${HOME}/workspace/stale`,
        customTitle: "A",
        lastModified: 1000,
      },
      {
        sessionId: "b",
        cwd: `${HOME}/workspace/fresh`,
        customTitle: "B",
        lastModified: 5000,
      },
    ]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    assert.deepEqual(
      projects.map((p) => p.name),
      ["fresh", "stale"],
    );
  });
});

describe("GET /api/projects — title resolution", () => {
  it("prefers the SDK customTitle for a session's summary", async () => {
    const app = setup([
      {
        sessionId: "a",
        cwd: `${HOME}/workspace/p`,
        customTitle: "My Custom Title",
        summary: "raw summary",
      },
    ]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    assert.equal(projects[0].sessions[0].summary, "My Custom Title");
    assert.equal(projects[0].sessions[0].customTitle, "My Custom Title");
  });

  it("falls back to the SDK summary when no custom title exists", async () => {
    // No customTitle → the route consults the JSONL title cache. Using a
    // random cwd guarantees no ~/.claude/projects dir exists for it, so the
    // cache misses and the SDK summary is the deterministic fallback.
    const app = setup([
      {
        sessionId: "a",
        cwd: `${HOME}/nonexistent-${randomUUID()}`,
        summary: "fallback summary",
      },
    ]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    assert.equal(projects[0].sessions[0].summary, "fallback summary");
    assert.equal(projects[0].sessions[0].customTitle, undefined);
  });
});

describe("GET /api/projects — agent enrichment & errors", () => {
  it("leaves sessions un-enriched when no autonomOS agent record matches", async () => {
    const app = setup([
      { sessionId: "a", cwd: `${HOME}/workspace/p`, customTitle: "A" },
    ]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    // Fresh temp config dir ⇒ empty agent store ⇒ default (unmanaged) shape.
    assert.equal(projects[0].sessions[0].isAutonomosAgent, undefined);
  });

  it("degrades to SDK summaries (200, not 500) when title resolution throws", async () => {
    // batchGetTitles can reject (e.g. HOME unset on a launchd-spawned server).
    // Title resolution is best-effort enrichment — it must not crash the listing.
    _setDepsForTesting({
      listSessions: async () =>
        fakeSessions([
          {
            sessionId: "a",
            cwd: `${HOME}/workspace/p`,
            summary: "raw summary",
          },
        ]),
      batchGetTitles: async () => {
        throw new Error("HOME environment variable is not set");
      },
    });
    const app = createApp();

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const projects = (await res.json()) as ProjectJson[];
    assert.equal(projects[0].sessions[0].summary, "raw summary");
  });

  it("returns 500 with a detail message when listSessions throws", async () => {
    _setDepsForTesting({
      listSessions: async () => {
        throw new Error("SDK exploded");
      },
    });
    const app = createApp();

    const res = await app.request("/api/projects");
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; detail: string };
    assert.match(body.error, /Failed to list Claude Code sessions/);
    assert.equal(body.detail, "SDK exploded");
  });
});

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
// The route's DEFAULT Codex/Gemini scanners read these; point them at paths
// that don't exist so no test can ever scan the operator's real history
// (setup() also stubs both scanners — this is the backstop).
process.env.CODEX_HOME = join(
  tmpdir(),
  `aos-projects-no-codex-${randomUUID()}`,
);
process.env.GEMINI_CLI_HOME = join(
  tmpdir(),
  `aos-projects-no-gemini-${randomUUID()}`,
);

const { projectRouter, _setDepsForTesting, _resetForTesting } = await import(
  "../routes/projects.js"
);

const { buildAgent, insertAgent, markExited, patchAgent } = await import(
  "../agents/store.js"
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
  _setDepsForTesting({
    listSessions: async () => fakeSessions(specs),
    listCodexSessions: async () => [],
    listGeminiSessions: async () => [],
  });
  return createApp();
}

interface ProjectJson {
  path: string;
  name: string;
  lastActive: number;
  sessions: {
    sessionId: string;
    provider: string;
    summary: string;
    isAutonomosAgent?: boolean;
    originator?: string;
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

  it("names a cwd-less session's project 'Unknown' (keyed per session, bug #7)", async () => {
    const app = setup([{ sessionId: "a", customTitle: "A" }]);

    const res = await app.request("/api/projects");
    const projects = (await res.json()) as ProjectJson[];

    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, "Unknown");
    // Keyed per-session (unknown:<id>) so unrelated cwd-less sessions don't merge.
    assert.ok(projects[0].path.startsWith("unknown:"));
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

    // The resolved title lives in `summary` (the redundant, misnamed
    // `customTitle` wire field is gone). Every CC row carries provider.
    assert.equal(projects[0].sessions[0].summary, "My Custom Title");
    assert.equal(projects[0].sessions[0].provider, "claude-code");
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

describe("GET /api/projects — provider + Codex seam + cwd-less", () => {
  it("tags every Claude Code row with provider:claude-code", async () => {
    const app = setup([
      { sessionId: "a", cwd: `${HOME}/workspace/p`, summary: "s" },
    ]);
    const projects = (await (
      await app.request("/api/projects")
    ).json()) as ProjectJson[];
    assert.equal(projects[0].sessions[0].provider, "claude-code");
  });

  it("merges Codex rows from the discovery seam into their cwd group", async () => {
    _setDepsForTesting({
      listSessions: async () =>
        fakeSessions([
          { sessionId: "cc1", cwd: `${HOME}/workspace/p`, summary: "cc" },
        ]),
      listCodexSessions: async () => [
        {
          cwd: `${HOME}/workspace/p`,
          session: {
            sessionId: "cx1",
            provider: "codex",
            summary: "Codex session · derived",
            lastModified: 1_700_000_005_000,
            originator: "external",
          },
        },
      ],
    });
    const app = createApp();
    const projects = (await (
      await app.request("/api/projects")
    ).json()) as ProjectJson[];
    // Same cwd → one project, both providers present.
    const p = projects.find((x) => x.name === "p");
    assert.ok(p, "expected a project named 'p'");
    assert.equal(p.sessions.length, 2);
    assert.deepEqual(p.sessions.map((s) => s.provider).sort(), [
      "claude-code",
      "codex",
    ]);
    const codex = p.sessions.find((s) => s.provider === "codex");
    assert.equal(codex?.originator, "external");
  });

  it("does NOT merge cwd-less sessions into one Unknown project (bug #7)", async () => {
    const app = setup([
      { sessionId: "a", summary: "a" }, // no cwd
      { sessionId: "b", summary: "b" }, // no cwd
    ]);
    const projects = (await (
      await app.request("/api/projects")
    ).json()) as ProjectJson[];
    const unknowns = projects.filter((x) => x.name === "Unknown");
    assert.equal(unknowns.length, 2); // separate groups, not merged into one
  });
});

describe("GET /api/projects — managed agents of EVERY runtime (Codex/Gemini)", () => {
  // Real agent records in the test's temp store.
  const mk = (
    provider: "codex" | "gemini-cli" | "claude-code",
    extra: { thread?: string } = {},
  ) => {
    const id = randomUUID();
    insertAgent(
      buildAgent({
        id: id as never,
        name: `${provider}-${id.slice(0, 4)}`,
        workingDirectory: `${HOME}/workspace/agents`,
        provider,
        providerSessionId: id,
        permissionMode: "ask",
        status: "running",
      }),
    );
    if (extra.thread)
      patchAgent(id as never, { providerThreadId: extra.thread });
    markExited(id as never, "user_killed");
    return id;
  };
  const get = async (app: ReturnType<typeof createApp>) =>
    (await (await app.request("/api/projects")).json()) as ProjectJson[];
  const rows = (ps: ProjectJson[]) =>
    ps.flatMap((p) => p.sessions.map((s) => ({ ...s, path: p.path })));

  it("an exited Codex agent's discovered thread becomes ITS row: agent id (resumable), runtime, its directory", async () => {
    const thread = `thread-${randomUUID()}`;
    const id = mk("codex", { thread });
    _setDepsForTesting({
      listSessions: async () => [],
      listGeminiSessions: async () => [],
      listCodexSessions: async () => [
        {
          cwd: "/private/tmp/elsewhere",
          session: {
            sessionId: thread,
            provider: "codex",
            summary: "audit",
            lastModified: 5,
          },
        },
      ],
    });
    const r = rows(await get(createApp())).find((s) => s.sessionId === id);
    assert.ok(
      r,
      "the managed Codex agent must have a row keyed by its resumable id",
    );
    assert.equal(r.provider, "codex");
    assert.equal(r.isAutonomosAgent, true);
    assert.equal(
      r.path,
      `${HOME}/workspace/agents`,
      "grouped under the agent's own directory",
    );
    assert.ok(
      !rows(await get(createApp())).some((s) => s.sessionId === thread),
      "no duplicate row under the thread id",
    );
  });

  it("matching is STABLE across polls even when the scanner hands back the same object (a cache)", async () => {
    const thread = `thread-${randomUUID()}`;
    const id = mk("codex", { thread });
    const cached = {
      cwd: "/private/tmp/elsewhere",
      session: {
        sessionId: thread,
        provider: "codex",
        summary: "audit",
        lastModified: 5,
      },
    };
    _setDepsForTesting({
      listSessions: async () => [],
      listGeminiSessions: async () => [],
      listCodexSessions: async () => [cached],
    });
    for (const poll of [1, 2, 3]) {
      const r = rows(await get(createApp())).find((s) => s.sessionId === id);
      assert.ok(r, `poll ${poll}: the managed row must still be matched`);
      assert.equal(
        r.path,
        `${HOME}/workspace/agents`,
        `poll ${poll}: grouped under the agent's directory`,
      );
    }
  });

  it("the INVERSE split: Claude Code's realpath group + a managed agent's raw path are ONE project", async (t) => {
    const { mkdtempSync, realpathSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const real = mkdtempSync(join(tmpdir(), "aos-inv-real-"));
    const link = join(tmpdir(), `aos-inv-link-${randomUUID()}`);
    try {
      symlinkSync(real, link);
    } catch {
      return t.skip("no symlinks here");
    }
    try {
      const id = randomUUID();
      insertAgent(
        buildAgent({
          id: id as never,
          name: "inv",
          workingDirectory: link, // the raw spelling
          provider: "codex",
          providerSessionId: id,
          permissionMode: "ask",
          status: "running",
        }),
      );
      markExited(id as never, "user_killed");
      _setDepsForTesting({
        // Claude Code recorded the REALPATH for this directory.
        listSessions: async () =>
          fakeSessions([{ sessionId: "cc-inv", cwd: realpathSync(real) }]),
        listGeminiSessions: async () => [],
        listCodexSessions: async () => [],
      });
      const ps = await get(createApp());
      const groups = ps.filter((x) =>
        x.sessions.some((s) => s.sessionId === "cc-inv" || s.sessionId === id),
      );
      assert.equal(groups.length, 1, "one directory, one project");
      assert.equal(
        groups[0].path,
        realpathSync(real),
        "Claude Code's own spelling is kept",
      );
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("a scanned realpath cwd joins the project the user knows by its raw path (/tmp vs /private/tmp)", async (t) => {
    const { mkdtempSync, realpathSync, rmSync, symlinkSync } = await import(
      "node:fs"
    );
    const real = mkdtempSync(join(tmpdir(), "aos-alias-real-"));
    const link = join(tmpdir(), `aos-alias-link-${randomUUID()}`);
    try {
      symlinkSync(real, link);
    } catch {
      return t.skip("no symlinks here");
    }
    try {
      _setDepsForTesting({
        listSessions: async () =>
          fakeSessions([{ sessionId: "cc-1", cwd: link }]),
        listGeminiSessions: async () => [],
        listCodexSessions: async () => [
          {
            cwd: realpathSync(real),
            session: {
              sessionId: "cx-1",
              provider: "codex",
              summary: "c",
              lastModified: 5,
            },
          },
        ],
      });
      const ps = await get(createApp());
      const p = ps.find((x) => x.path === link);
      assert.ok(p, "the raw path stays the project's path");
      assert.deepEqual(p.sessions.map((x) => x.sessionId).sort(), [
        "cc-1",
        "cx-1",
      ]);
      assert.ok(
        !ps.some((x) => x.path === realpathSync(real)),
        "no second group under the realpath",
      );
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("an exited Gemini agent with a saved session is matched by providerSessionId", async () => {
    const id = mk("gemini-cli");
    _setDepsForTesting({
      listSessions: async () => [],
      listCodexSessions: async () => [],
      listGeminiSessions: async () => [
        {
          cwd: `${HOME}/workspace/agents`,
          session: {
            sessionId: id,
            provider: "gemini-cli",
            summary: "x",
            lastModified: 5,
          },
        },
      ],
    });
    const matches = rows(await get(createApp())).filter(
      (s) => s.sessionId === id,
    );
    assert.equal(
      matches.length,
      1,
      "exactly one row — the discovered one, not also a filler",
    );
    assert.equal(matches[0].isAutonomosAgent, true);
    assert.equal(matches[0].provider, "gemini-cli");
  });

  it("an exited agent with NO discoverable session still gets a row (e.g. Codex killed before its first turn)", async () => {
    const id = mk("codex"); // no thread: codex never saved one
    _setDepsForTesting({
      listSessions: async () => [],
      listCodexSessions: async () => [],
      listGeminiSessions: async () => [],
    });
    const r = rows(await get(createApp())).find((s) => s.sessionId === id);
    assert.ok(r, "a managed agent of any runtime must show in Projects");
    assert.equal(r.provider, "codex");
    assert.equal(r.isAutonomosAgent, true);
  });

  it("an EXTERNAL Codex session (no agent record) stays unmanaged, with its originator", async () => {
    _setDepsForTesting({
      listSessions: async () => [],
      listGeminiSessions: async () => [],
      listCodexSessions: async () => [
        {
          cwd: "/w/ext",
          session: {
            sessionId: "ext-1",
            provider: "codex",
            summary: "mine",
            lastModified: 5,
            originator: "external",
          },
        },
      ],
    });
    const r = rows(await get(createApp())).find((s) => s.sessionId === "ext-1");
    assert.ok(r);
    assert.equal(r.isAutonomosAgent, undefined);
    assert.equal(r.originator, "external");
  });

  it("a MANAGED row with no prompt yet reads as its agent's name; an external one keeps the placeholder", async () => {
    const id = mk("gemini-cli");
    _setDepsForTesting({
      listSessions: async () => [],
      listCodexSessions: async () => [],
      listGeminiSessions: async () => [
        {
          cwd: "/w",
          session: {
            sessionId: id,
            provider: "gemini-cli",
            summary: "(no prompt yet)",
            lastModified: 5,
          },
        },
        {
          cwd: "/w",
          session: {
            sessionId: "ext-g",
            provider: "gemini-cli",
            summary: "(no prompt yet)",
            lastModified: 5,
          },
        },
      ],
    });
    const all = rows(await get(createApp()));
    assert.match(
      all.find((s) => s.sessionId === id)?.summary ?? "",
      /^gemini-cli-/,
    );
    assert.equal(
      all.find((s) => s.sessionId === "ext-g")?.summary,
      "(no prompt yet)",
    );
  });

  it("one scanner throwing costs only its own rows", async () => {
    _setDepsForTesting({
      listSessions: async () => [],
      listCodexSessions: async () => {
        throw new Error("EACCES");
      },
      listGeminiSessions: async () => [
        {
          cwd: "/w/g",
          session: {
            sessionId: "g-ok",
            provider: "gemini-cli",
            summary: "ok",
            lastModified: 5,
          },
        },
      ],
    });
    const res = await createApp().request("/api/projects");
    assert.equal(res.status, 200);
    assert.ok(
      rows((await res.json()) as ProjectJson[]).some(
        (s) => s.sessionId === "g-ok",
      ),
    );
  });
});

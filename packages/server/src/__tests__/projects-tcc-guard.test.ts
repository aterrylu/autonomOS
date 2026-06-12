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
  `autonomos-tcc-test-${randomUUID()}`,
);

const {
  projectRouter,
  isTccProtectedPath,
  _setDepsForTesting,
  _resetForTesting,
} = await import("../routes/projects.js");

const HOME = "/Users/testuser";

describe("isTccProtectedPath — deny-list path logic", () => {
  it("blocks direct children of protected roots", () => {
    assert.equal(isTccProtectedPath(`${HOME}/Documents/proj`, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/Desktop/scratch`, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/Downloads/repo`, HOME), true);
    assert.equal(
      isTccProtectedPath(
        `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/proj`,
        HOME,
      ),
      true,
    );
    assert.equal(isTccProtectedPath(`${HOME}/Pictures/x`, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/Music/x`, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/Movies/x`, HOME), true);
  });

  it("blocks the protected root itself", () => {
    assert.equal(isTccProtectedPath(`${HOME}/Documents`, HOME), true);
  });

  it("blocks deeply nested paths under protected roots", () => {
    assert.equal(isTccProtectedPath(`${HOME}/Documents/a/b/c`, HOME), true);
  });

  it("blocks the home directory itself (git would walk upward from ~)", () => {
    assert.equal(isTccProtectedPath(HOME, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/`, HOME), true);
  });

  it("allows normal workspace paths", () => {
    assert.equal(isTccProtectedPath(`${HOME}/workspace/foo`, HOME), false);
    assert.equal(
      isTccProtectedPath(`${HOME}/.claude-worktrees/x`, HOME),
      false,
    );
    assert.equal(isTccProtectedPath("/tmp/repo", HOME), false);
  });

  it("respects path boundaries — sibling dirs sharing a prefix are allowed", () => {
    assert.equal(isTccProtectedPath(`${HOME}/DocumentsFoo`, HOME), false);
    assert.equal(isTccProtectedPath(`${HOME}/Desktop2/proj`, HOME), false);
    assert.equal(isTccProtectedPath(`${HOME}/MoviesArchive`, HOME), false);
  });

  it("normalizes trailing slashes", () => {
    assert.equal(isTccProtectedPath(`${HOME}/Documents/proj/`, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/workspace/foo/`, HOME), false);
  });

  it("matches case-insensitively (macOS APFS is case-insensitive)", () => {
    assert.equal(isTccProtectedPath(`${HOME}/documents/proj`, HOME), true);
    assert.equal(isTccProtectedPath(`${HOME}/DOWNLOADS/repo`, HOME), true);
    assert.equal(
      isTccProtectedPath(`${HOME}/library/mobile documents/proj`, HOME),
      true,
    );
    assert.equal(isTccProtectedPath("/users/TESTUSER", HOME), true);
    // boundary still respected after folding
    assert.equal(isTccProtectedPath(`${HOME}/documentsFoo`, HOME), false);
  });
});

// ── Endpoint-level tests ───────────────────────────────────────

interface FakeSessionSpec {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
}

function fakeSessions(specs: FakeSessionSpec[]): SDKSessionInfo[] {
  return specs.map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    summary: `session ${s.sessionId}`,
    customTitle: `title ${s.sessionId}`, // skips the titleCache lookup
    lastModified: 1700000000000,
    firstPrompt: "hello",
  })) as unknown as SDKSessionInfo[];
}

function createApp() {
  const app = new Hono();
  app.route("/api/projects", projectRouter);
  return app;
}

const GIT_STDOUT = " 2 files changed, 10 insertions(+), 3 deletions(-)\n";

function setup(
  specs: FakeSessionSpec[],
  opts: {
    platform?: NodeJS.Platform;
    execImpl?: (cwd: string) => Promise<{ stdout: string; stderr: string }>;
  } = {},
) {
  const execCalls: { cwd: string }[] = [];
  let nowMs = 1_000_000;
  _setDepsForTesting({
    listSessions: async () => fakeSessions(specs),
    homedir: () => HOME,
    existsSync: () => true,
    execFileAsync: async (_file, _args, options) => {
      execCalls.push({ cwd: options.cwd });
      if (opts.execImpl) return opts.execImpl(options.cwd);
      return { stdout: GIT_STDOUT, stderr: "" };
    },
    now: () => nowMs,
    platform: () => opts.platform ?? "darwin",
  });
  return {
    app: createApp(),
    execCalls,
    advanceTime: (ms: number) => {
      nowMs += ms;
    },
  };
}

function execError(props: { code?: string | number; killed?: boolean }): Error {
  return Object.assign(new Error("exec failed"), props);
}

afterEach(() => {
  _resetForTesting();
});

describe("GET /api/projects — TCC guard", () => {
  it("never execs git for sessions under protected roots, still returns the project", async () => {
    const protectedCwd = `${HOME}/Documents/old-project`;
    const { app, execCalls } = setup([
      { sessionId: "s1", cwd: protectedCwd, gitBranch: "main" },
      {
        sessionId: "s2",
        cwd: `${HOME}/Library/Mobile Documents/proj`,
        gitBranch: "dev",
      },
      { sessionId: "s3", cwd: HOME, gitBranch: "main" },
    ]);

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const projects = (await res.json()) as {
      path: string;
      sessions: { gitDiffStat?: unknown }[];
    }[];

    assert.equal(execCalls.length, 0, "no git exec under protected roots");
    const proj = projects.find((p) => p.path === protectedCwd);
    assert.ok(proj, "protected project still listed");
    assert.equal(proj.sessions[0].gitDiffStat, undefined);
  });

  it("execs git and returns diff stats for safe workspace repos", async () => {
    const safeCwd = `${HOME}/workspace/autonomOS`;
    const { app, execCalls } = setup([
      { sessionId: "s1", cwd: safeCwd, gitBranch: "feature" },
    ]);

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const projects = (await res.json()) as {
      path: string;
      sessions: { gitDiffStat?: { insertions: number; deletions: number } }[];
    }[];

    assert.deepEqual(execCalls, [{ cwd: safeCwd }]);
    assert.deepEqual(projects[0].sessions[0].gitDiffStat, {
      insertions: 10,
      deletions: 3,
    });
  });

  it("skips exec when cwd has no .git directory", async () => {
    const { app, execCalls } = setup([
      {
        sessionId: "s1",
        cwd: `${HOME}/workspace/not-a-repo`,
        gitBranch: "main",
      },
    ]);
    _setDepsForTesting({
      listSessions: async () =>
        fakeSessions([
          {
            sessionId: "s1",
            cwd: `${HOME}/workspace/not-a-repo`,
            gitBranch: "main",
          },
        ]),
      homedir: () => HOME,
      existsSync: () => false,
      execFileAsync: async (_file, _args, options) => {
        execCalls.push({ cwd: options.cwd });
        return { stdout: GIT_STDOUT, stderr: "" };
      },
    });

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    assert.equal(execCalls.length, 0);
  });

  it("skips exec for sessions without a gitBranch", async () => {
    const { app, execCalls } = setup([
      { sessionId: "s1", cwd: `${HOME}/workspace/foo` },
    ]);

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    assert.equal(execCalls.length, 0);
  });
});

describe("GET /api/projects — platform gate", () => {
  it("does not apply the TCC deny-list off macOS", async () => {
    const docsCwd = `${HOME}/Documents/linux-project`;
    const { app, execCalls } = setup(
      [{ sessionId: "s1", cwd: docsCwd, gitBranch: "main" }],
      { platform: "linux" },
    );

    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    assert.deepEqual(
      execCalls,
      [{ cwd: docsCwd }],
      "Linux ~/Documents repos keep their badge",
    );
  });
});

describe("GET /api/projects — git failure classification", () => {
  const safeCwd = `${HOME}/workspace/autonomOS`;
  const specs = [{ sessionId: "s1", cwd: safeCwd, gitBranch: "feature" }];

  it("returns 200 with no badge when git exits non-zero, and caches the negative", async () => {
    const { app, execCalls } = setup(specs, {
      execImpl: async () => {
        throw execError({ code: 128 });
      },
    });

    let res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const projects = (await res.json()) as {
      sessions: { gitDiffStat?: unknown }[];
    }[];
    assert.equal(projects[0].sessions[0].gitDiffStat, undefined);

    res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    assert.equal(execCalls.length, 1, "completed git failure is cached");
  });

  it("does not cache transient timeouts (killed exec)", async () => {
    const { app, execCalls } = setup(specs, {
      execImpl: async () => {
        throw execError({ killed: true });
      },
    });

    await app.request("/api/projects");
    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    assert.equal(execCalls.length, 2, "timeout retried on next poll");
  });

  it("returns 200 and does not cache when the git binary is missing (ENOENT)", async () => {
    const { app, execCalls } = setup(specs, {
      execImpl: async () => {
        throw execError({ code: "ENOENT" });
      },
    });

    let res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    assert.equal(execCalls.length, 2, "ENOENT not cached as a repo result");
  });
});

describe("GET /api/projects — diff-stat cache", () => {
  it("does not re-exec git within the TTL", async () => {
    const safeCwd = `${HOME}/workspace/autonomOS`;
    const { app, execCalls } = setup([
      { sessionId: "s1", cwd: safeCwd, gitBranch: "feature" },
    ]);

    await app.request("/api/projects");
    const res = await app.request("/api/projects");
    assert.equal(res.status, 200);
    const projects = (await res.json()) as {
      sessions: { gitDiffStat?: { insertions: number } }[];
    }[];

    assert.equal(execCalls.length, 1, "second poll served from cache");
    assert.equal(projects[0].sessions[0].gitDiffStat?.insertions, 10);
  });

  it("re-execs git after the TTL expires", async () => {
    const safeCwd = `${HOME}/workspace/autonomOS`;
    const { app, execCalls, advanceTime } = setup([
      { sessionId: "s1", cwd: safeCwd, gitBranch: "feature" },
    ]);

    await app.request("/api/projects");
    advanceTime(120_000);
    await app.request("/api/projects");

    assert.equal(execCalls.length, 2);
  });
});

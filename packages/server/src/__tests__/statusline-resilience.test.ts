/**
 * Statusline resilience: the identity line must not flip to "offline" and
 * the branch must not vanish just because the box is busy.
 *
 * Measured cause (50-agent load rig): a fresh statusline process's first
 * fetch costs 25-280ms of undici cold start before the request leaves (the
 * old budget was 200ms), and a `git branch` spawn missed its 100ms budget in
 * 96% of ticks. So the renderer now keeps a per-agent last-known-good cache,
 * reads the branch from .git/HEAD, and only says "offline" on a definitive
 * answer or after a long silence.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  chooseIdentity,
  fetchSelf,
  OFFLINE_AFTER_MS,
  readGitBranch,
  resolveBranch,
  STALE_AFTER_MS,
} from "../providers/statusline.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../providers/statusline.mjs",
);
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, "");
const META = {
  name: "Worker@proj",
  manager: "Lead",
  project: "proj",
  directReports: 0,
};

// ── chooseIdentity (the policy) ───────────────────────────────

describe("chooseIdentity", () => {
  const now = 1_000_000_000;
  const cache = (ageMs: number) => ({ meta: META, metaAt: now - ageMs });

  it("a fresh answer always wins", () => {
    assert.deepEqual(chooseIdentity({ meta: META }, cache(1e9), now), {
      kind: "fresh",
      meta: META,
    });
  });

  it("a timeout shows the last good answer, undimmed while recent", () => {
    assert.deepEqual(chooseIdentity({ error: "timeout" }, cache(5_000), now), {
      kind: "cached",
      meta: META,
      stale: false,
    });
  });

  it("dims once the last good answer passes STALE_AFTER_MS", () => {
    const r = chooseIdentity({ error: "timeout" }, cache(STALE_AFTER_MS), now);
    assert.equal(r.kind, "cached");
    assert.equal(r.kind === "cached" && r.stale, true);
  });

  it("goes offline only after OFFLINE_AFTER_MS of silence", () => {
    assert.equal(
      chooseIdentity({ error: "timeout" }, cache(OFFLINE_AFTER_MS - 1), now)
        .kind,
      "cached",
    );
    assert.equal(
      chooseIdentity({ error: "timeout" }, cache(OFFLINE_AFTER_MS), now).kind,
      "offline",
    );
  });

  it("5xx and transport errors are not definitive", () => {
    for (const result of [
      { error: "http", status: 500 },
      { error: "http", status: 503 },
      { error: "other" },
      { error: "bad-body" },
    ])
      assert.equal(chooseIdentity(result, cache(1_000), now).kind, "cached");
  });

  it("refused / 401 / 404 are definitive: offline at once, cache or not", () => {
    for (const result of [
      { error: "refused" },
      { error: "http", status: 401 },
      { error: "http", status: 404 },
    ])
      assert.equal(chooseIdentity(result, cache(1_000), now).kind, "offline");
  });

  it("no cache (first tick) → offline on any failure", () => {
    assert.equal(
      chooseIdentity({ error: "timeout" }, null, now).kind,
      "offline",
    );
  });

  it("a cache stamped in the future (clock jump) is not trusted", () => {
    assert.equal(
      chooseIdentity({ error: "timeout" }, cache(-60_000), now).kind,
      "offline",
    );
  });
});

// ── readGitBranch / resolveBranch ─────────────────────────────

describe("readGitBranch (no git process)", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });

  before(() => {
    root = mkdtempSync(join(tmpdir(), "sl-git-"));
    git(root, "init", "-q", "-b", "feat/main-branch", "repo");
    const repo = join(root, "repo");
    git(
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git(repo, "worktree", "add", "-q", "-b", "wt/linked", join(root, "wt"));
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("reads the branch of a plain repo", () => {
    assert.equal(readGitBranch(join(root, "repo")), "feat/main-branch");
  });

  it("follows a linked worktree's .git FILE to its own HEAD", () => {
    assert.equal(readGitBranch(join(root, "wt")), "wt/linked");
  });

  it("agrees with `git branch --show-current` for both", () => {
    for (const d of ["repo", "wt"]) {
      const viaGit = execFileSync("git", ["branch", "--show-current"], {
        cwd: join(root, d),
        encoding: "utf8",
      }).trim();
      assert.equal(readGitBranch(join(root, d)), viaGit);
    }
  });

  it("walks up from a subdirectory, but only to the ceiling", () => {
    const deep = join(root, "repo", "src", "deep");
    assert.equal(readGitBranch(deep, join(root, "repo")), "feat/main-branch");
    // Ceiling = the subdirectory itself: never looks above it.
    assert.equal(readGitBranch(deep, deep), null);
  });

  it("detached HEAD → null (like `git branch --show-current`)", () => {
    const d = mkdtempSync(join(tmpdir(), "sl-det-"));
    mkdirSync(join(d, ".git"));
    writeFileSync(
      join(d, ".git", "HEAD"),
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n",
    );
    assert.equal(readGitBranch(d), null);
    rmSync(d, { recursive: true, force: true });
  });

  it("not a repo → null", () => {
    const d = mkdtempSync(join(tmpdir(), "sl-none-"));
    assert.equal(readGitBranch(d), null);
    rmSync(d, { recursive: true, force: true });
  });

  it("an unreadable HEAD falls back to the cached branch", () => {
    const d = mkdtempSync(join(tmpdir(), "sl-bad-"));
    mkdirSync(join(d, ".git")); // a .git dir with no HEAD → read error
    assert.throws(() => readGitBranch(d));
    assert.equal(
      resolveBranch({ workspace: { current_dir: d } }, "cached/branch"),
      "cached/branch",
    );
    rmSync(d, { recursive: true, force: true });
  });
});

// ── fetchSelf error classification ────────────────────────────

describe("fetchSelf classification", () => {
  it("nothing listening → refused", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    await new Promise<void>((r) => srv.close(() => r()));
    const r = await fetchSelf("a", `http://127.0.0.1:${port}`, "tok");
    assert.equal(r.error, "refused");
  });

  it("401 → http/401", async () => {
    const srv = createServer((_q, s) => {
      s.statusCode = 401;
      s.end("{}");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    const r = await fetchSelf("a", `http://127.0.0.1:${port}`, "tok");
    assert.deepEqual(r, { error: "http", status: 401 });
    srv.close();
  });
});

// ── The real script, end to end ───────────────────────────────

describe("statusline process: busy server never reads as offline", () => {
  let dir: string;
  let repo: string;
  let srv: Server;
  let port: number;
  let mode: "ok" | "hang" = "ok";
  let lastRaw = "";
  const SID = "agent-1";

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "sl-e2e-"));
    mkdirSync(join(dir, "agent-tokens"));
    writeFileSync(join(dir, "agent-tokens", SID), "tok");
    repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "feat/e2e", repo]);
    srv = createServer((_q, s) => {
      if (mode === "hang") return; // never answers: a stalled server
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify(META));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as AddressInfo).port;
  });
  after(() => {
    srv.closeAllConnections();
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the real script. PATH holds ONLY node's directory: no git binary,
   *  so a branch in the output can only have come from .git/HEAD. */
  function tick(server = `http://127.0.0.1:${port}`) {
    return new Promise<string[]>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          PATH: dirname(process.execPath),
          AUTONOMOS_SESSION_ID: SID,
          AUTONOMOS_SERVER: server,
          AUTONOMOS_CONFIG_DIR: dir,
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.on("close", () => {
        lastRaw = out;
        resolve(plain(out).split("\n"));
      });
      child.stdin.end(
        JSON.stringify({ workspace: { current_dir: repo, project_dir: repo } }),
      );
    });
  }
  const cacheFile = () => join(dir, "statusline-cache", `${SID}.json`);
  const ageCache = (ms: number) => {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    c.metaAt = Date.now() - ms;
    writeFileSync(cacheFile(), JSON.stringify(c));
  };

  it("fresh: renders the hierarchy and the branch, and caches both", async () => {
    mode = "ok";
    const [l1, l2] = await tick();
    assert.equal(l1, "[Worker@proj · ↑Lead]");
    assert.match(l2, /🌿 feat\/e2e/);
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    assert.deepEqual(c.meta, META);
    assert.equal(c.branch, "feat/e2e");
  });

  it("a server that stops answering keeps the last identity (not offline)", async () => {
    mode = "hang";
    const [l1, l2] = await tick();
    assert.equal(l1, "[Worker@proj · ↑Lead]");
    assert.match(l2, /🌿 feat\/e2e/);
    assert.ok(!lastRaw.startsWith("\x1b[2m["), "recent cache is not dimmed");
  });

  it("…dims it once the last answer is stale", async () => {
    mode = "hang";
    ageCache(STALE_AFTER_MS + 1_000);
    const [l1] = await tick();
    assert.equal(l1, "[Worker@proj · ↑Lead]"); // same words…
    assert.ok(lastRaw.startsWith("\x1b[2m["), "…all dim"); // …all dim
  });

  it("…and only reads offline after OFFLINE_AFTER_MS of silence", async () => {
    mode = "hang";
    ageCache(OFFLINE_AFTER_MS + 1_000);
    const [l1, l2] = await tick();
    assert.equal(l1, "[autonomos · offline]");
    assert.match(l2, /🌿 feat\/e2e/, "the branch never depends on the server");
  });

  it("a refused connection is offline at once, even with a fresh cache", async () => {
    mode = "ok";
    await tick(); // re-warm the cache
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const [l1] = await tick(`http://127.0.0.1:${deadPort}`);
    assert.equal(l1, "[autonomos · offline]");
  });
});

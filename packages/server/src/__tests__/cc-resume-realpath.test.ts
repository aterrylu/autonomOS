import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import { exitOutputTail } from "../agents/runtime.js";
import {
  claudeCodeProvider,
  claudeProjectsDir,
} from "../providers/claude-code.js";
import {
  batchGetTitles,
  candidateProjectCwds,
  cwdToDirName,
} from "../titleCache.js";

/**
 * Claude Code resume on a SYMLINKED cwd (ADR-111).
 *
 * CC files a session JSONL under the REALPATH of its cwd (verified on 2.1.281:
 * a session started in /…/link lands in -private-…-real/). The resume probe
 * used the UNRESOLVED path → ENOENT → "not resumable" → a fresh
 * `--session-id` reusing a live id → CC: "Session ID … is already in use",
 * exit 1, agent crashed. On macOS `/var` is itself a symlink, so this hit every
 * `os.tmpdir()` / `$TMPDIR` cwd — every isolated test instance — not just /tmp.
 */

const SID = "22222222-2222-4222-8222-222222222222";
let root: string;
let home: string;
let realDir: string;
let linkDir: string;

function opts(cwd: string): ResolvedSpawnOptions {
  return {
    workingDirectory: cwd,
    cwd,
    sessionId: "agent-id",
    agentName: "Worker",
    providerSessionId: SID,
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "3101",
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:3101",
  };
}
/** Write a session JSONL the way CC does: under `<projects>/<enc(dirCwd)>/`. */
function writeSession(projects: string, dirCwd: string, id = SID): void {
  const d = join(projects, cwdToDirName(dirCwd));
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${id}.jsonl`),
    '{"type":"custom-title","customTitle":"Symlinked title"}\n',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aos-realpath-"));
  home = join(root, "home");
  mkdirSync(home);
  realDir = join(root, "real");
  mkdirSync(realDir);
  linkDir = join(root, "link");
  symlinkSync(realDir, linkDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("hasResumableSession — probes where CC actually files the session", () => {
  const envFor = () => ({ HOME: home });

  it("SYMLINKED cwd: finds the JSONL CC filed under the realpath (was: false → crash)", () => {
    writeSession(join(home, ".claude", "projects"), realpathSync(linkDir));
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(linkDir), envFor()),
      true,
    );
  });

  it("$TMPDIR / /var/folders cwd (macOS /var is a symlink): resolves too", () => {
    // realDir itself sits under os.tmpdir() — unresolved on macOS it is
    // /var/folders/…, while CC files it under /private/var/folders/….
    writeSession(join(home, ".claude", "projects"), realpathSync(realDir));
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(realDir), envFor()),
      true,
    );
  });

  it("falls back to the RAW path spelling (older layouts)", () => {
    writeSession(join(home, ".claude", "projects"), linkDir);
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(linkDir), envFor()),
      true,
    );
  });

  it("no JSONL under either spelling → not resumable", () => {
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(linkDir), envFor()),
      false,
    );
  });

  it("an unresolvable cwd uses the raw path (no throw)", () => {
    const gone = join(root, "does-not-exist");
    assert.deepEqual(candidateProjectCwds(gone), [gone]);
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(gone), envFor()),
      false,
    );
  });

  it("follows the CHILD's absolute CLAUDE_CONFIG_DIR (a preset can relocate it)", () => {
    const cfg = join(root, "cfg");
    writeSession(join(cfg, "projects"), realpathSync(realDir));
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(realDir), {
        HOME: home,
        CLAUDE_CONFIG_DIR: cfg,
      }),
      true,
    );
    // …and does NOT find it when the child's env has no relocation.
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(opts(realDir), envFor()),
      false,
    );
  });
});

describe("claudeProjectsDir — matches CC's own resolution (claude auth status)", () => {
  it("HOME default", () => {
    assert.equal(
      claudeProjectsDir("/w", { HOME: "/h" }),
      "/h/.claude/projects",
    );
  });
  it("absolute CLAUDE_CONFIG_DIR", () => {
    assert.equal(
      claudeProjectsDir("/w", { HOME: "/h", CLAUDE_CONFIG_DIR: "/c" }),
      "/c/projects",
    );
  });
  it("RELATIVE CLAUDE_CONFIG_DIR resolves against the child's cwd", () => {
    assert.equal(
      claudeProjectsDir("/w", { HOME: "/h", CLAUDE_CONFIG_DIR: "rel/cfg" }),
      "/w/rel/cfg/projects",
    );
    assert.equal(
      claudeProjectsDir("/w", { HOME: "/h", CLAUDE_CONFIG_DIR: "./dot" }),
      "/w/dot/projects",
    );
  });
  it("does NOT expand ~ (the spawn env has no shell; CC keeps it literal)", () => {
    assert.equal(
      claudeProjectsDir("/w", { HOME: "/h", CLAUDE_CONFIG_DIR: "~/cc" }),
      "/w/~/cc/projects",
    );
  });
});

describe("titleCache — symlinked cwds get their titles (same root cause)", () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
  it("resolves a title filed under the realpath when asked with the symlink", async () => {
    writeSession(join(home, ".claude", "projects"), realpathSync(linkDir));
    const titles = await batchGetTitles([{ sessionId: SID, cwd: linkDir }]);
    assert.equal(titles.get(SID), "Symlinked title");
  });
});

describe("exitOutputTail — the fast-exit log names the process's own reason", () => {
  it("strips ANSI and keeps the last lines (CC's 'already in use')", () => {
    const buf = [
      "\x1b[2J\x1b[H\x1b[?25l",
      "starting…\r\n",
      "\x1b[31mError: Session ID abc is already in use.\x1b[0m\r\n",
    ];
    assert.equal(
      exitOutputTail(buf),
      "starting… | Error: Session ID abc is already in use.",
    );
  });
  it("empty output → empty string (caller prints '(none)')", () => {
    assert.equal(exitOutputTail([]), "");
  });
  it("caps very long output", () => {
    const out = exitOutputTail(["x".repeat(1000)], 3, 50);
    assert.ok(out.startsWith("…") && out.length === 51);
  });
});

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { claudeJsonPath, preTrustWorkdir } from "../providers/claude-code.js";

/**
 * Spawn-side trust pre-seeding (the PREVENTION half of auto-trust).
 *
 * CC ≥2.1.26x defaults its trust dialog to "❯ No, exit"; dismissing it by
 * keystroke is race-prone (an Ink re-mount resets the selection between our
 * Down and Enter — observed killing an agent 0.7s after spawn). Writing
 * `projects[<realpath cwd>].hasTrustDialogAccepted: true` into CC's own
 * config BEFORE the process spawns removes the dialog entirely. These tests
 * pin the write shape, its idempotence, and every skip path — a failure here
 * must never block a spawn.
 */
describe("preTrustWorkdir — CC config pre-seeding", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "pretrust-"));

  it("adds hasTrustDialogAccepted for the realpath'd cwd, preserving everything else", () => {
    const dir = tmp();
    const cfg = join(dir, ".claude.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        numStartups: 7,
        projects: { "/some/other": { hasTrustDialogAccepted: true, x: 1 } },
      }),
    );
    const work = join(dir, "work");
    mkdirSync(work);

    preTrustWorkdir(work, cfg);

    const out = JSON.parse(readFileSync(cfg, "utf8"));
    // realpathSync resolves the tmpdir symlink (/var → /private/var on
    // macOS) exactly the way CC keys its projects map.
    const real = realpathSync(work);
    assert.equal(out.projects[real]?.hasTrustDialogAccepted, true);
    assert.equal(out.numStartups, 7, "unrelated top-level keys preserved");
    assert.deepEqual(
      out.projects["/some/other"],
      { hasTrustDialogAccepted: true, x: 1 },
      "other projects preserved",
    );
  });

  it("is idempotent and never overwrites an existing decision (false stays false)", () => {
    const dir = tmp();
    const cfg = join(dir, ".claude.json");
    const work = join(dir, "work");
    mkdirSync(work);
    const real = realpathSync(work);
    writeFileSync(
      cfg,
      JSON.stringify({
        projects: { [real]: { hasTrustDialogAccepted: false } },
      }),
    );
    const before = readFileSync(cfg, "utf8");

    preTrustWorkdir(work, cfg);

    assert.equal(
      readFileSync(cfg, "utf8"),
      before,
      "a recorded decision — even a decline — is left untouched",
    );
  });

  it("skips silently when the config file does not exist (fresh CC install)", () => {
    const dir = tmp();
    // must not throw, must not create the file
    preTrustWorkdir(dir, join(dir, ".claude.json"));
    assert.throws(() => statSync(join(dir, ".claude.json")));
  });

  it("skips silently on malformed JSON without destroying the file", () => {
    const dir = tmp();
    const cfg = join(dir, ".claude.json");
    writeFileSync(cfg, "{ not json !!!");
    preTrustWorkdir(dir, cfg);
    assert.equal(readFileSync(cfg, "utf8"), "{ not json !!!");
  });

  it("keys by resolved path when cwd is reached through a symlink", () => {
    const dir = tmp();
    const cfg = join(dir, ".claude.json");
    writeFileSync(cfg, JSON.stringify({ projects: {} }));
    const realDir = join(dir, "real");
    mkdirSync(realDir);
    const linkDir = join(dir, "link");
    symlinkSync(realDir, linkDir);

    preTrustWorkdir(linkDir, cfg);

    const out = JSON.parse(readFileSync(cfg, "utf8"));
    const real = realpathSync(realDir);
    assert.equal(
      out.projects[real]?.hasTrustDialogAccepted,
      true,
      "trust recorded under the REAL path, the key CC looks up",
    );
    assert.ok(!(linkDir in out.projects), "no entry under the symlink path");
  });
});

describe("claudeJsonPath — CLAUDE_CONFIG_DIR precedence", () => {
  // Hardcoding ~/.claude.json made pre-trust a silent no-op under a
  // relocated CC config: we mutated a file nothing reads while the child
  // (which inherits the server env) read CLAUDE_CONFIG_DIR/.claude.json and
  // rendered the dialog anyway.
  it("resolves under CLAUDE_CONFIG_DIR when set, home default otherwise", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = "/tmp/relocated-cc";
      assert.equal(claudeJsonPath(), "/tmp/relocated-cc/.claude.json");
      process.env.CLAUDE_CONFIG_DIR = "   ";
      assert.ok(
        claudeJsonPath().endsWith("/.claude.json") &&
          !claudeJsonPath().includes("relocated"),
        "blank value falls back to the home default",
      );
      delete process.env.CLAUDE_CONFIG_DIR;
      assert.ok(claudeJsonPath().endsWith("/.claude.json"));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

/**
 * The drift probe reads each CLI's accepted permission values from its own
 * output. Every parser here runs against REAL output captured from the
 * installed CLIs (fixtures/runtime-probe/*.json), and the table is checked
 * against those captures — so a table edit that drifts from what the CLIs
 * actually accept fails here, not at spawn time.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RUNTIME_PERMISSIONS } from "@autonomos/core";
import {
  _resetRuntimeProbeCacheForTesting,
  compareAxis,
  getPermissionCheck,
  parseClaudeChoices,
  parseCodexSchemaEnum,
  parseCodexVariants,
  parseGeminiChoices,
  parseVersion,
  probeRuntime,
} from "../runtimeProbe.js";

const fx = (name: string): { exit: number; output: string } =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/runtime-probe/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const schema = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/runtime-probe/codex-schema-subset.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const axis = (runtime: "claude-code" | "codex" | "gemini-cli", key: string) => {
  const a = RUNTIME_PERMISSIONS[runtime].axes.find((x) => x.key === key);
  assert.ok(a, `${runtime} has no axis ${key}`);
  return a;
};

describe("parsers, on real CLI output", () => {
  it("versions", () => {
    assert.equal(parseVersion(fx("claude-version").output), "2.1.282");
    assert.equal(parseVersion(fx("gemini-version").output), "0.46.0");
    assert.equal(parseVersion(fx("codex-version").output), "0.154.0");
    assert.equal(parseVersion("no version here"), null);
  });

  it("Claude Code's allowed-choices list", () => {
    const out = fx("claude-mode-probe");
    assert.equal(
      out.exit,
      1,
      "precondition: an invalid value fails at parse time",
    );
    assert.deepEqual(parseClaudeChoices(out.output), [
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "manual",
      "dontAsk",
      "plan",
    ]);
  });

  it("Gemini's choices list", () => {
    const out = fx("gemini-mode-probe");
    assert.equal(out.exit, 1);
    assert.deepEqual(parseGeminiChoices(out.output), [
      "default",
      "auto_edit",
      "yolo",
      "plan",
    ]);
  });

  it("Codex's config variants", () => {
    assert.deepEqual(parseCodexVariants(fx("codex-sandbox-probe").output), [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    assert.deepEqual(parseCodexVariants(fx("codex-reviewer-probe").output), [
      "user",
      "auto_review",
      "guardian_subagent",
    ]);
    // The approval list still names removed values — only loading tells them apart.
    assert.ok(
      parseCodexVariants(fx("codex-approval-probe").output)?.includes(
        "untrusted",
      ),
    );
    assert.notEqual(fx("codex-approval-untrusted").exit, 0);
    assert.equal(fx("codex-approval-onrequest").exit, 0);
  });

  it("Codex's collaboration modes, from its schema", () => {
    assert.deepEqual(parseCodexSchemaEnum(schema, "ModeKind"), [
      "plan",
      "default",
    ]);
  });

  it("returns null (can't tell) on unrecognized output", () => {
    assert.equal(parseClaudeChoices("something else"), null);
    assert.equal(parseGeminiChoices("something else"), null);
    assert.equal(parseCodexVariants("something else"), null);
  });
});

describe("the table matches what the installed CLIs accept", () => {
  it("Claude Code", () => {
    const c = compareAxis(
      axis("claude-code", "permission-mode"),
      parseClaudeChoices(fx("claude-mode-probe").output),
    );
    assert.deepEqual([c.rejected, c.unlisted], [[], []]);
  });
  it("Gemini", () => {
    const c = compareAxis(
      axis("gemini-cli", "approval-mode"),
      parseGeminiChoices(fx("gemini-mode-probe").output),
    );
    assert.deepEqual([c.rejected, c.unlisted], [[], []]);
  });
  it("Codex sandbox, reviewer, collaboration mode", () => {
    for (const [key, name] of [
      ["sandbox_mode", "codex-sandbox-probe"],
      ["approvals_reviewer", "codex-reviewer-probe"],
    ] as const) {
      const c = compareAxis(
        axis("codex", key),
        parseCodexVariants(fx(name).output),
      );
      assert.deepEqual([c.rejected, c.unlisted], [[], []], key);
    }
    const m = compareAxis(
      axis("codex", "collaboration_mode"),
      parseCodexSchemaEnum(schema, "ModeKind"),
    );
    assert.deepEqual([m.rejected, m.unlisted], [[], []]);
  });
  it("Codex approval: removed values that still load aren't reported as new", () => {
    // What the loader actually accepts on 0.154: on-failure (coerced) + the two real values.
    const c = compareAxis(axis("codex", "approval_policy"), [
      "on-failure",
      "on-request",
      "never",
    ]);
    assert.deepEqual([c.rejected, c.unlisted], [[], []]);
  });
});

describe("compareAxis reports drift", () => {
  it("a value the CLI dropped is rejected; a new one is unlisted", () => {
    const c = compareAxis(axis("gemini-cli", "approval-mode"), [
      "default",
      "auto_edit",
      "plan",
      "turbo",
    ]);
    assert.deepEqual(c.rejected, ["yolo"]);
    assert.deepEqual(c.unlisted, ["turbo"]);
  });
  it("unreadable output is 'unknown', never 'all rejected'", () => {
    const c = compareAxis(axis("gemini-cli", "approval-mode"), null);
    assert.equal(c.accepted, null);
    assert.deepEqual(c.rejected, []);
  });
});

describe("probeRuntime end to end (a fake Claude Code)", () => {
  it("puts the value before --version, which short-circuits validation", async () => {
    // Like the real CLI: a leading --version prints the version and exits
    // WITHOUT validating anything after it.
    const dir = mkdtempSync(join(tmpdir(), "aos-probe-fake-"));
    try {
      const bin = join(dir, "claude");
      writeFileSync(
        bin,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.282 (Claude Code)"; exit 0; fi
if [ "$1" = "--permission-mode" ] && [ "$2" = "__probe__" ]; then
  echo "error: option '--permission-mode <mode>' argument '__probe__' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan." >&2
  exit 1
fi
exit 0
`,
      );
      chmodSync(bin, 0o755);
      const check = await probeRuntime("claude-code", bin);
      assert.equal(check.error, undefined);
      assert.equal(check.version, "2.1.282");
      assert.equal(check.versionChanged, false);
      assert.deepEqual(check.axes[0].rejected, []);
      assert.ok(check.axes[0].accepted?.includes("manual"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a probe that couldn't tell is NOT cached — the next request re-probes", async () => {
    // The marker is OUTSIDE the binary on purpose: editing the binary would
    // change its mtime, i.e. the cache key, and hide the bug.
    const dir = mkdtempSync(join(tmpdir(), "aos-probe-flaky-"));
    const down = join(dir, "down");
    try {
      const bin = join(dir, "claude");
      writeFileSync(
        bin,
        `#!/bin/sh
if [ -e "${down}" ]; then exit 1; fi
if [ "$1" = "--version" ]; then echo "2.1.282 (Claude Code)"; exit 0; fi
exit 0
`,
      );
      chmodSync(bin, 0o755);
      writeFileSync(down, "");
      _resetRuntimeProbeCacheForTesting();
      const first = await getPermissionCheck("claude-code", bin);
      assert.equal(
        first.version,
        null,
        "precondition: the first probe couldn't tell",
      );
      rmSync(down);
      const second = await getPermissionCheck("claude-code", bin);
      assert.equal(
        second.version,
        "2.1.282",
        "re-probed, not served from cache",
      );
      // …and a GOOD result IS cached (same object back, no re-probe).
      assert.equal(await getPermissionCheck("claude-code", bin), second);
    } finally {
      _resetRuntimeProbeCacheForTesting();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing binary is reported as a probe failure, not as 'every value rejected'", async () => {
    const check = await probeRuntime("gemini-cli", "/nonexistent/gemini");
    assert.equal(check.version, null);
    assert.ok(
      check.axes.every((a) => a.accepted === null && a.rejected.length === 0),
    );
  });
});

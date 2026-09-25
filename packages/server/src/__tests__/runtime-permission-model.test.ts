/**
 * The per-runtime permission model (ADR-115): canonical values, the migration
 * from the shared ask|auto|plan|bypass vocabulary, parsing API input, and the
 * canonical display string.
 *
 * The migration table is the load-bearing part: every legacy mode must map to
 * the native setting the agent ACTUALLY ran — never wider, never narrower.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completePermission,
  DEFAULT_RUNTIME_VALUES,
  formatPermission,
  legacyModeFor,
  legacyModeWasClamped,
  PERMISSION_MODES,
  type Provider,
  parseRuntimePermission,
  permissionFromLegacyMode,
  RUNTIME_PERMISSIONS,
} from "@autonomos/core";

const RUNTIMES: Provider[] = ["claude-code", "codex", "gemini-cli"];

describe("defaults are exactly today's ask behavior", () => {
  it("every runtime's default is a valid value on every axis", () => {
    for (const r of RUNTIMES) {
      for (const axis of RUNTIME_PERMISSIONS[r].axes) {
        const v = DEFAULT_RUNTIME_VALUES[r][axis.key];
        assert.ok(
          axis.values.some((x) => x.value === v),
          `${r} ${axis.key} default ${v} isn't in the table`,
        );
      }
    }
  });
  it("Codex's default keeps today's sandbox (danger-full-access), not a tighter one", () => {
    assert.equal(
      DEFAULT_RUNTIME_VALUES.codex.sandbox_mode,
      "danger-full-access",
    );
    assert.equal(DEFAULT_RUNTIME_VALUES.codex.approval_policy, "on-request");
  });
});

describe("migration from the shared vocabulary keeps effective behavior", () => {
  const expected: Record<Provider, Record<string, string>> = {
    "claude-code": {
      ask: "manual",
      auto: "acceptEdits",
      plan: "plan",
      bypass: "bypassPermissions",
    },
    "gemini-cli": {
      ask: "default",
      auto: "auto_edit",
      plan: "plan",
      bypass: "yolo",
    },
    codex: {
      ask: "on-request",
      auto: "on-request",
      plan: "on-request",
      bypass: "never",
    },
  };
  for (const r of RUNTIMES) {
    for (const mode of PERMISSION_MODES) {
      it(`${r} ${mode}`, () => {
        const p = permissionFromLegacyMode(r, mode);
        const primary = RUNTIME_PERMISSIONS[r].axes[0].key;
        assert.equal(p.values[primary], expected[r][mode]);
        if (r === "codex")
          assert.equal(p.values.sandbox_mode, "danger-full-access");
      });
    }
  }
  it("only Codex auto/plan were clamped (they get the one-time notice)", () => {
    const clamped = RUNTIMES.flatMap((r) =>
      PERMISSION_MODES.filter((m) => legacyModeWasClamped(r, m)).map(
        (m) => `${r}:${m}`,
      ),
    );
    assert.deepEqual(clamped, ["codex:auto", "codex:plan"]);
  });
  it("round-trips to the legacy projection wherever an exact equivalent exists", () => {
    for (const r of RUNTIMES) {
      for (const mode of PERMISSION_MODES) {
        if (legacyModeWasClamped(r, mode)) continue;
        assert.equal(
          legacyModeFor(permissionFromLegacyMode(r, mode)),
          mode,
          `${r} ${mode}`,
        );
      }
    }
  });
});

describe("parseRuntimePermission — the API input", () => {
  it("single-axis runtimes take the bare canonical value", () => {
    const r = parseRuntimePermission("claude-code", "acceptEdits");
    assert.ok(r.ok);
    assert.equal(r.permission.values["permission-mode"], "acceptEdits");
  });
  it("Codex takes its own key=value spelling, and an object; unnamed axes keep the default", () => {
    for (const input of [
      "approval_policy=never sandbox_mode=danger-full-access",
      "approval_policy=never, sandbox_mode=danger-full-access",
      { approval_policy: "never", sandbox_mode: "danger-full-access" },
    ]) {
      const r = parseRuntimePermission("codex", input);
      assert.ok(r.ok, JSON.stringify(input));
      assert.equal(r.permission.values.approval_policy, "never");
      assert.equal(r.permission.values.approvals_reviewer, "user");
    }
  });
  it("rejects another runtime's value and lists the valid ones", () => {
    const r = parseRuntimePermission("gemini-cli", "bypassPermissions");
    assert.equal(r.ok, false);
    assert.match(
      r.ok ? "" : r.error,
      /gemini-cli: default\|auto_edit\|plan\|yolo/,
    );
  });
  it("rejects a bare value on a multi-axis runtime, naming each axis", () => {
    const r = parseRuntimePermission("codex", "never");
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /approval_policy=on-request\|never/);
  });
  it("rejects an unknown key", () => {
    assert.equal(parseRuntimePermission("codex", "approval=never").ok, false);
  });
});

describe("formatPermission — the canonical display string", () => {
  it("bare value for single-axis runtimes", () => {
    assert.equal(
      formatPermission(
        completePermission("gemini-cli", { "approval-mode": "yolo" }),
      ),
      "yolo",
    );
  });
  it("Codex: key=value pairs, quiet about reviewer/collaboration defaults", () => {
    assert.equal(
      formatPermission(completePermission("codex")),
      "approval_policy=on-request · sandbox_mode=danger-full-access",
    );
    assert.equal(
      formatPermission(
        completePermission("codex", { approvals_reviewer: "auto_review" }),
      ),
      "approval_policy=on-request · sandbox_mode=danger-full-access · approvals_reviewer=auto_review",
    );
  });
  it("format → parse round-trips", () => {
    const p = completePermission("codex", {
      approval_policy: "never",
      collaboration_mode: "plan",
    });
    const back = parseRuntimePermission("codex", formatPermission(p));
    assert.ok(back.ok);
    assert.deepEqual(back.permission, p);
  });
});

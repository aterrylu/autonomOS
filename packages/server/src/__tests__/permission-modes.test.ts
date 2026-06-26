import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODE_INFO,
  PERMISSION_MODES,
  type PermissionMode,
  permissionModeFromLegacy,
  type ResolvedSpawnOptions,
} from "@autonomos/core";
import { claudeCodeProvider } from "../providers/claude-code.js";
import { geminiCliProvider } from "../providers/gemini-cli.js";

/**
 * Per-provider permission-mode mapping (ADR-045). Codex's daemon/TUI mapping is
 * covered in codex-daemon.test.ts; this file covers Claude + Gemini argv and the
 * shared core helpers (migration, defaults, the explainer matrix).
 */

function baseOptions(
  overrides: Partial<ResolvedSpawnOptions> = {},
): ResolvedSpawnOptions {
  return {
    workingDirectory: "/work",
    cwd: "/work",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "Agent",
    providerSessionId: "22222222-2222-4222-8222-222222222222",
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "53917",
    capabilities: ["send"],
    ...overrides,
  };
}

describe("core permission helpers", () => {
  it("DEFAULT_PERMISSION_MODE preserves the historical autonomous default", () => {
    // The old autonomousMode defaulted to true (skip-permissions) everywhere;
    // an unspecified permissionMode must keep that behavior. See ADR-045.
    assert.equal(DEFAULT_PERMISSION_MODE, "bypass");
  });

  it("permissionModeFromLegacy maps the old boolean (accept-and-discard)", () => {
    assert.equal(permissionModeFromLegacy(true), "bypass");
    assert.equal(permissionModeFromLegacy(false), "default");
    assert.equal(permissionModeFromLegacy(undefined), undefined);
  });

  it("isPermissionMode is a correct type guard", () => {
    for (const mode of PERMISSION_MODES) assert.ok(isPermissionMode(mode));
    assert.ok(!isPermissionMode("nonsense"));
    assert.ok(!isPermissionMode(true));
    assert.ok(!isPermissionMode(undefined));
  });

  it("PERMISSION_MODE_INFO describes every mode for every provider", () => {
    for (const mode of PERMISSION_MODES) {
      const info = PERMISSION_MODE_INFO[mode];
      assert.ok(info, `missing info for ${mode}`);
      assert.ok(info.label && info.summary);
      for (const provider of ["claude-code", "gemini-cli", "codex"] as const) {
        assert.ok(info.perProvider[provider], `${mode}/${provider} missing`);
      }
    }
    // Codex is the only provider that can't represent plan.
    assert.deepEqual(PERMISSION_MODE_INFO.plan.unsupportedBy, ["codex"]);
  });
});

describe("claude-code permission mapping", () => {
  const expected: Record<PermissionMode, string[]> = {
    default: ["--permission-mode", "default"],
    auto: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"],
    bypass: ["--dangerously-skip-permissions"],
  };

  for (const mode of PERMISSION_MODES) {
    it(`maps '${mode}' to the leading Claude flags`, () => {
      const args = claudeCodeProvider.buildArgs(
        baseOptions({ permissionMode: mode }),
      );
      assert.deepEqual(args.slice(0, expected[mode].length), expected[mode]);
    });
  }

  it("bypass does NOT also pass --permission-mode", () => {
    const args = claudeCodeProvider.buildArgs(
      baseOptions({ permissionMode: "bypass" }),
    );
    assert.ok(!args.includes("--permission-mode"));
  });
});

describe("gemini-cli permission mapping", () => {
  const expected: Record<PermissionMode, string> = {
    default: "default",
    auto: "auto_edit",
    plan: "plan",
    bypass: "yolo",
  };

  for (const mode of PERMISSION_MODES) {
    it(`maps '${mode}' to --approval-mode ${expected[mode]}`, () => {
      const args = geminiCliProvider.buildArgs(
        baseOptions({ permissionMode: mode }),
      );
      const idx = args.indexOf("--approval-mode");
      assert.ok(idx >= 0, "expected --approval-mode flag");
      assert.equal(args[idx + 1], expected[mode]);
    });
  }
});

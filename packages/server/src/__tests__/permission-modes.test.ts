import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  PERMISSION_MODE_INFO,
  PERMISSION_MODES,
  type PermissionMode,
  permissionModeFromLegacy,
  permissionModeFromStored,
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
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:53917",

    ...overrides,
  };
}

describe("core permission helpers", () => {
  it("DEFAULT_PERMISSION_MODE is the fail-closed 'ask' (prompt before acting)", () => {
    // A spawn that forgets to set a mode must NOT silently get full autonomy.
    // bypass is opt-in (the original ADR-045 default was flipped — see ADR-045).
    assert.equal(DEFAULT_PERMISSION_MODE, "ask");
  });

  it("permissionModeFromLegacy maps the old boolean (accept-and-discard)", () => {
    assert.equal(permissionModeFromLegacy(true), "bypass");
    assert.equal(permissionModeFromLegacy(false), "ask");
    assert.equal(permissionModeFromLegacy(undefined), undefined);
  });

  it("permissionModeFromStored accepts the pre-rename spelling", () => {
    // Records, templates, and browser localStorage written before the rename
    // still say "default". They must load as "ask", not as garbage — a coercion
    // to the fallback would happen to produce the same value here, so assert
    // the alias path specifically rather than the end result.
    assert.equal(permissionModeFromStored("default"), "ask");
    // Current spellings pass through untouched.
    for (const mode of PERMISSION_MODES) {
      assert.equal(permissionModeFromStored(mode), mode);
    }
    // Anything else is NOT silently mapped — callers decide the fallback.
    assert.equal(permissionModeFromStored("yolo"), undefined);
    assert.equal(permissionModeFromStored(undefined), undefined);
    assert.equal(permissionModeFromStored(true), undefined);
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
  // `ask` emits NO permission flag (it IS Claude's built-in behavior, and
  // passing `--permission-mode default` explicitly perturbs TUI startup); the
  // others carry an explicit leading flag.
  const expected: Record<PermissionMode, string[]> = {
    ask: [],
    auto: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"],
    bypass: ["--dangerously-skip-permissions"],
  };

  for (const mode of ["auto", "plan", "bypass"] as const) {
    it(`maps '${mode}' to the leading Claude flags`, () => {
      const args = claudeCodeProvider.buildArgs(
        baseOptions({ permissionMode: mode }),
      );
      assert.deepEqual(args.slice(0, expected[mode].length), expected[mode]);
    });
  }

  it("ask mode emits NO permission flag (claude's built-in default)", () => {
    const args = claudeCodeProvider.buildArgs(
      baseOptions({ permissionMode: "ask" }),
    );
    assert.ok(!args.includes("--permission-mode"));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  });

  it("bypass does NOT also pass --permission-mode", () => {
    const args = claudeCodeProvider.buildArgs(
      baseOptions({ permissionMode: "bypass" }),
    );
    assert.ok(!args.includes("--permission-mode"));
  });
});

describe("gemini-cli permission mapping", () => {
  // Note `ask: "default"` — Gemini's OWN flag value for ask-before-acting is
  // the word "default". Our enum no longer uses that word, so this line is now
  // an explicit our-name → their-name translation rather than an identity that
  // hid one. Do not "simplify" it back.
  const expected: Record<PermissionMode, string> = {
    ask: "default",
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

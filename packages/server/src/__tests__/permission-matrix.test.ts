/**
 * EVERY runtime × EVERY canonical permission value (and every combination of
 * Codex's launch axes) → the exact argv/env the provider builds. Generated from
 * RUNTIME_PERMISSIONS, against an INDEPENDENT oracle written here: a value added
 * to the table without an expectation fails the meta test below, so no option
 * can ship untested (Terry's condition on #448, 2026-10-01).
 *
 * The oracle never calls the providers' own mapping code, so a mapping bug
 * can't make its own test pass.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  completePermission,
  type Provider,
  parseRuntimePermission,
  type ResolvedSpawnOptions,
  RUNTIME_PERMISSIONS,
} from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = mkdtempSync(join(tmpdir(), "aos-pmx-"));

// buildEnv requires the control plane to look bound (ADR-055); nothing connects.
const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53941);
setAuthToken("test-token-permission-matrix-abcdef");
setInternalSocketPath(join(tmpdir(), "aos-pmx.sock"));
const { claudeCodeProvider } = await import("../providers/claude-code.js");
const { codexProvider } = await import("../providers/codex.js");
const { geminiCliProvider } = await import("../providers/gemini-cli.js");
const { updateSettings } = await import("../settings.js");

const EP = "ws://127.0.0.1:59123";

function opts(over: Partial<ResolvedSpawnOptions>): ResolvedSpawnOptions {
  return {
    workingDirectory: "/work",
    cwd: "/work",
    sessionId: "11111111-1111-4111-8111-111111111111",
    agentName: "Agent",
    providerSessionId: "22222222-2222-4222-8222-222222222222",
    injectChannelServer: false,
    ...over,
  } as ResolvedSpawnOptions;
}

// ── The oracle: what each value MUST emit, written out by hand ──────────────

/** Claude Code `--permission-mode` values → the permission tokens on argv. */
const CLAUDE: Record<string, string[]> = {
  // ADR-119 (measured): manual is spawned with NO flag (Claude Code's own
  // default) — passing it leaked processes past teardown.
  manual: [],
  acceptEdits: ["--permission-mode", "acceptEdits"],
  auto: ["--permission-mode", "auto"],
  dontAsk: ["--permission-mode", "dontAsk"],
  plan: ["--permission-mode", "plan"],
  // The skip flag, and NO --permission-mode beside it.
  bypassPermissions: ["--dangerously-skip-permissions"],
};

/** Gemini `--approval-mode` values: passed verbatim. */
const GEMINI: Record<string, string[]> = {
  default: ["--approval-mode", "default"],
  auto_edit: ["--approval-mode", "auto_edit"],
  plan: ["--approval-mode", "plan"],
  yolo: ["--approval-mode", "yolo"],
};

/** Every Codex launch-axis value this oracle knows how to expect. */
const CODEX_KNOWN: Record<string, string[]> = {
  approval_policy: ["on-request", "never"],
  sandbox_mode: ["read-only", "workspace-write", "danger-full-access"],
  approvals_reviewer: ["user", "auto_review", "guardian_subagent"],
};

/** Codex's fresh `--remote` TUI argv for one combination (no prompt). */
function codexTuiArgv(v: Record<string, string>): string[] {
  // Every Codex TUI runs inline (ADR-135): its alternate screen can't scroll.
  const base = [
    "--remote",
    EP,
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    'tui.alternate_screen="never"',
  ];
  // Codex's all-in-one skip flag = exactly approval never + no sandbox.
  if (
    v.approval_policy === "never" &&
    v.sandbox_mode === "danger-full-access"
  ) {
    return [...base, "--dangerously-bypass-approvals-and-sandbox"];
  }
  return [
    ...base,
    "-s",
    v.sandbox_mode,
    "-c",
    `approval_policy="${v.approval_policy}"`,
    "-c",
    `approvals_reviewer="${v.approvals_reviewer}"`,
  ];
}

/** The `-c` pairs the Codex daemon must carry for one combination. */
function codexDaemonPairs(v: Record<string, string>): string[] {
  return [
    `sandbox_mode="${v.sandbox_mode}"`,
    `approval_policy="${v.approval_policy}"`,
    `approvals_reviewer="${v.approvals_reviewer}"`,
    // MCP-tool approval mirrors the shell policy (ADR-085).
    `mcp_servers.autonomos.default_tools_approval_mode="${v.approval_policy === "never" ? "approve" : "writes"}"`,
  ];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const launchAxes = (r: Provider) =>
  RUNTIME_PERMISSIONS[r].axes.filter((a) => !a.perTurn);

/** Every combination of a runtime's launch-axis values. */
function combos(r: Provider): Array<Record<string, string>> {
  let out: Array<Record<string, string>> = [{}];
  for (const axis of launchAxes(r)) {
    out = out.flatMap((c) =>
      axis.values.map((v) => ({ ...c, [axis.key]: v.value })),
    );
  }
  return out;
}

/** Claude's permission tokens, in order (the rest of argv is other flags). */
function claudePermTokens(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dangerously-skip-permissions") out.push(args[i]);
    if (args[i] === "--permission-mode") out.push(args[i], args[i + 1]);
  }
  return out;
}

/** `-c` values in an argv, in order. */
function configPairs(args: string[]): string[] {
  return args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
}

// ── The meta test: nothing in the table is untested ─────────────────────────

describe("the oracle covers every value in RUNTIME_PERMISSIONS", () => {
  it("a value added to the table without an expectation here FAILS", () => {
    const missing: string[] = [];
    for (const { value } of RUNTIME_PERMISSIONS["claude-code"].axes[0].values)
      if (!(value in CLAUDE))
        missing.push(`claude-code permission-mode=${value}`);
    for (const { value } of RUNTIME_PERMISSIONS["gemini-cli"].axes[0].values)
      if (!(value in GEMINI)) missing.push(`gemini-cli approval-mode=${value}`);
    for (const axis of launchAxes("codex")) {
      for (const { value } of axis.values)
        if (!CODEX_KNOWN[axis.key]?.includes(value))
          missing.push(`codex ${axis.key}=${value}`);
    }
    // A launch axis the oracle has never heard of is untested too.
    for (const axis of launchAxes("codex"))
      if (!(axis.key in CODEX_KNOWN)) missing.push(`codex axis ${axis.key}`);
    assert.deepEqual(
      missing,
      [],
      `add an expectation to permission-matrix.test.ts for: ${missing.join(", ")}`,
    );
    assert.equal(
      RUNTIME_PERMISSIONS["claude-code"].axes.length,
      1,
      "Claude Code grew a permission axis: extend the oracle",
    );
    assert.equal(
      RUNTIME_PERMISSIONS["gemini-cli"].axes.length,
      1,
      "Gemini grew a permission axis: extend the oracle",
    );
  });
});

// ── Claude Code ─────────────────────────────────────────────────────────────

describe("claude-code: every permission-mode → exact permission argv", () => {
  for (const { value } of RUNTIME_PERMISSIONS["claude-code"].axes[0].values) {
    it(`permission-mode=${value}`, () => {
      const args = claudeCodeProvider.buildArgs(
        opts({
          permission: completePermission("claude-code", {
            "permission-mode": value,
          }),
        }),
      );
      assert.deepEqual(claudePermTokens(args), CLAUDE[value]);
    });
  }
});

// ── Gemini CLI ──────────────────────────────────────────────────────────────

describe("gemini-cli: every approval-mode × Auto-Trust → exact argv and env", () => {
  for (const { value } of RUNTIME_PERMISSIONS["gemini-cli"].axes[0].values) {
    for (const autoTrust of [true, false]) {
      it(`approval-mode=${value}, Auto-Trust ${autoTrust ? "on" : "off"}`, () => {
        updateSettings({ autoTrust });
        const o = opts({
          permission: completePermission("gemini-cli", {
            "approval-mode": value,
          }),
        });
        const args = geminiCliProvider.buildArgs(o);
        const i = args.indexOf("--approval-mode");
        assert.deepEqual(args.slice(i, i + 2), GEMINI[value]);
        assert.equal(
          args.filter((a) => a === "--approval-mode").length,
          1,
          "one --approval-mode",
        );
        // Trust is an ENV var, never a flag (an older Gemini would refuse an
        // unknown flag but ignores an unknown env var).
        assert.ok(!args.some((a) => /trust/i.test(a)), "a trust flag on argv");
        const env = geminiCliProvider.buildEnv(o.sessionId, o.agentName);
        assert.equal(
          env.GEMINI_CLI_TRUST_WORKSPACE,
          autoTrust ? "true" : undefined,
        );
      });
    }
  }
});

// ── Codex ───────────────────────────────────────────────────────────────────

describe("codex: every launch-axis combination → exact TUI argv, daemon config, and a flagless resume", () => {
  for (const v of combos("codex")) {
    const name = Object.entries(v)
      .map(([k, x]) => `${k}=${x}`)
      .join(" ");
    it(name, () => {
      const permission = completePermission("codex", v);
      // Fresh TUI: exact.
      const tui = codexProvider.buildArgs(
        opts({ sidecarEndpoint: EP, permission }),
      );
      assert.deepEqual(tui, codexTuiArgv(v), "fresh --remote TUI");
      // Daemon: every permission pair, in Codex's own keys.
      const daemon =
        codexProvider.buildSidecar?.(
          opts({ sidecarEndpoint: EP, permission, injectChannelServer: true }),
        )?.args ?? [];
      const pairs = configPairs(daemon);
      for (const p of codexDaemonPairs(v))
        assert.ok(pairs.includes(p), `daemon lacks -c ${p}`);
      // Resume: codex rejects permission overrides on `resume --remote`, so
      // NOTHING permission-shaped may be passed (ADR-104).
      const resume = codexProvider.buildArgs(
        opts({
          sidecarEndpoint: EP,
          permission,
          providerThreadId: "thread-1",
        }),
      );
      assert.deepEqual(resume, [
        "resume",
        "thread-1",
        "--remote",
        EP,
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'tui.alternate_screen="never"',
      ]);
      // The per-turn axis is never set at launch, on any path.
      for (const a of [...tui, ...daemon, ...resume])
        assert.ok(!a.includes("collaboration_mode"), a);
    });
  }

  it("a non-default collaboration_mode is REFUSED (it's per turn, Shift+Tab inside Codex)", () => {
    const axis = RUNTIME_PERMISSIONS.codex.axes.find((a) => a.perTurn);
    assert.ok(axis, "precondition: Codex has a per-turn axis");
    for (const { value } of axis.values) {
      const r = parseRuntimePermission("codex", { [axis.key]: value });
      if (value === "default") assert.equal(r.ok, true, value);
      else assert.equal(r.ok, false, `${axis.key}=${value} was accepted`);
    }
  });
});

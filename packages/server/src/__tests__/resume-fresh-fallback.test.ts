import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import { resumeSafetyNetArmed } from "../agents/runtime.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { claudeCodeProvider } from "../providers/claude-code.js";
import { codexProvider } from "../providers/codex.js";
import { cwdToDirName } from "../titleCache.js";

/**
 * Provider-parity resume fallback (ADR-049).
 *
 * Bug: on a `make dev` restart, Codex agents persisted but Claude Code agents
 * vanished. Root cause asymmetry — Claude Code's resume path is unconditional
 * (`claude --resume <id>`), but CC writes its session JSONL lazily (on the
 * first turn), so a never-conversed agent has no resume target and crashes on
 * boot → marked exited → filtered out of the org chart. Codex degrades to a
 * fresh thread instead, so it survives.
 *
 * These tests pin the contracts the runtime fix depends on:
 *   1. claude-code exposes `hasResumableSession` reflecting on-disk reality.
 *   2. clearing `resumeSessionId` makes buildArgs emit a FRESH same-id spawn
 *      (`--session-id <id>`) instead of `--resume <id>` — the runtime's B
 *      pre-flight fallback.
 *   3. codex has NO `hasResumableSession` hook (it self-handles via the
 *      presence/absence of a thread id) — documenting why only CC needs B.
 */

let tmpHome: string;
let tmpConfig: string;
let prevHome: string | undefined;

function baseOptions(
  overrides: Partial<ResolvedSpawnOptions> = {},
): ResolvedSpawnOptions {
  return {
    workingDirectory: "/tmp/proj",
    cwd: "/tmp/proj",
    sessionId: "test-session-id",
    agentName: "Worker",
    providerSessionId: "11111111-1111-4111-8111-111111111111",
    injectChannelServer: false,
    channelServerScript: "/tmp/channel-server.mjs",
    serverPort: "3101",
    ...overrides,
  };
}

/** Create the CC session JSONL at the exact path hasResumableSession probes. */
function writeClaudeSession(cwd: string, sessionId: string): void {
  const dir = join(tmpHome, ".claude", "projects", cwdToDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "{}\n");
}

describe("claudeCodeProvider.hasResumableSession", () => {
  beforeEach(() => {
    prevHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "autonomos-home-"));
    process.env.HOME = tmpHome;
    tmpConfig = mkdtempSync(join(tmpdir(), "autonomos-cfg-"));
    _setConfigDirForTesting(tmpConfig);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    _resetConfigDirForTesting();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
  });

  it("returns false when the session JSONL has not been written yet", () => {
    // The never-conversed agent: record exists, but CC wrote no session file.
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(baseOptions()),
      false,
    );
  });

  it("returns true once the session JSONL exists on disk", () => {
    const opts = baseOptions();
    writeClaudeSession(opts.cwd, opts.providerSessionId);
    assert.equal(claudeCodeProvider.hasResumableSession?.(opts), true);
  });

  it("is scoped to the exact cwd + session id (no false positives)", () => {
    // A session under a DIFFERENT cwd must not satisfy a resume for this cwd.
    writeClaudeSession("/tmp/other-proj", baseOptions().providerSessionId);
    assert.equal(
      claudeCodeProvider.hasResumableSession?.(baseOptions()),
      false,
    );
  });
});

describe("claudeCodeProvider.buildArgs — resume vs fresh fallback", () => {
  beforeEach(() => {
    tmpConfig = mkdtempSync(join(tmpdir(), "autonomos-cfg-"));
    _setConfigDirForTesting(tmpConfig);
    writeFileSync(join(tmpConfig, "settings.json"), "{}\n", { mode: 0o600 });
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    rmSync(tmpConfig, { recursive: true, force: true });
  });

  it("emits --resume <id> when resumeSessionId is set", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const args = claudeCodeProvider.buildArgs(
      baseOptions({ resumeSessionId: id, providerSessionId: id }),
    );
    const i = args.indexOf("--resume");
    assert.ok(i >= 0, "expected --resume");
    assert.equal(args[i + 1], id);
    assert.ok(
      !args.includes("--session-id"),
      "resume must not also --session-id",
    );
  });

  it("falls back to a FRESH same-id spawn when resumeSessionId is cleared", () => {
    // This is the runtime's B pre-flight outcome: resumeSessionId undefined but
    // providerSessionId retained → CC starts a new session under the same id.
    const id = "33333333-3333-4333-8333-333333333333";
    const args = claudeCodeProvider.buildArgs(
      baseOptions({ resumeSessionId: undefined, providerSessionId: id }),
    );
    assert.ok(!args.includes("--resume"), "fresh fallback must not --resume");
    const i = args.indexOf("--session-id");
    assert.ok(i >= 0, "expected --session-id for fresh spawn");
    assert.equal(
      args[i + 1],
      id,
      "fresh spawn reuses the same providerSessionId",
    );
  });
});

describe("provider parity — only claude-code needs the resume pre-flight", () => {
  it("codex does NOT implement hasResumableSession (self-handles via thread id)", () => {
    // Codex's buildArgs already degrades to a fresh `--remote` thread when no
    // providerThreadId is present, so the runtime's unconditional behavior is
    // correct for it — no pre-flight hook required.
    assert.equal(codexProvider.hasResumableSession, undefined);
  });

  it("codex buildArgs: fresh --remote when no thread id, resume when present", () => {
    const ep = "ws://127.0.0.1:5000";
    const fresh = codexProvider.buildArgs(
      baseOptions({ sidecarEndpoint: ep, providerThreadId: undefined }),
    );
    assert.ok(fresh.includes("--remote"), "fresh codex uses --remote");
    assert.ok(!fresh.includes("resume"), "fresh codex must not resume");

    const tid = "44444444-4444-4444-8444-444444444444";
    const resumed = codexProvider.buildArgs(
      baseOptions({ sidecarEndpoint: ep, providerThreadId: tid }),
    );
    assert.equal(resumed[0], "resume");
    assert.equal(resumed[1], tid);
  });
});

/**
 * resumeSafetyNetArmed decides whether the onExit fresh-respawn net fires. The
 * subtlety is the loop-breaker: `resumeSessionId` is set on EVERY respawn
 * (provider-agnostic), so arming on it alone would make a provider WITHOUT a
 * pre-flight hook (Codex) re-fire forever on a persistent non-resume crash —
 * the regression this gating prevents. Codex must arm only via providerThreadId
 * (which the net clears); Claude Code arms via resumeSessionId only because its
 * pre-flight clears that field on the regenerated-id respawn.
 */
describe("resumeSafetyNetArmed — onExit net loop-breaker", () => {
  const SID = "55555555-5555-4555-8555-555555555555";
  const TID = "66666666-6666-4666-8666-666666666666";

  it("Claude Code: armed on a real --resume (has pre-flight hook)", () => {
    assert.equal(
      resumeSafetyNetArmed({ resumeSessionId: SID, hasResumeHook: true }),
      true,
    );
  });

  it("Claude Code: NOT armed once the pre-flight cleared resumeSessionId", () => {
    // The fresh-fallback respawn — loop broken.
    assert.equal(
      resumeSafetyNetArmed({ resumeSessionId: undefined, hasResumeHook: true }),
      false,
    );
  });

  it("Codex: armed via threadId even though resumeSessionId is always set", () => {
    assert.equal(
      resumeSafetyNetArmed({
        resumeSessionId: SID,
        providerThreadId: TID,
        hasResumeHook: false,
      }),
      true,
    );
  });

  it("Codex: NOT armed after the net cleared the threadId (loop broken)", () => {
    // REGRESSION GUARD: a bare resumeSessionId + no hook must NOT keep the net
    // armed, or a Codex agent crashing for a non-resume reason loops forever.
    assert.equal(
      resumeSafetyNetArmed({
        resumeSessionId: SID,
        providerThreadId: undefined,
        hasResumeHook: false,
      }),
      false,
    );
  });

  it("Codex: NOT armed on a fresh first spawn (no threadId, no hook)", () => {
    assert.equal(
      resumeSafetyNetArmed({ resumeSessionId: SID, hasResumeHook: false }),
      false,
    );
  });
});

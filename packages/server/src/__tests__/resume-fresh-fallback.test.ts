import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import {
  resumeSafetyNetArmed,
  retainedThreadCrashNotice,
} from "../agents/runtime.js";
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
    socketPath: "/tmp/aos-test/control.sock",
    apiUrl: "http://localhost:3101",

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

describe("provider parity — the pre-flight hook is claude-code-only", () => {
  it("codex does NOT implement hasResumableSession (no pre-flight hook)", () => {
    // Codex cannot prove on disk whether a thread is resumable before spawn, so
    // it declares no pre-flight hook. Post-ADR-100 that absence is exactly why
    // the destructive onExit net does NOT arm for a Codex resume-crash: with no
    // proof the thread is the culprit, the crash retains the thread (resumable)
    // rather than force-freshing it away. buildArgs still degrades to a fresh
    // `--remote` thread when no providerThreadId is present.
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
 * resumeSafetyNetArmed decides whether the onExit DESTRUCTIVE fresh-respawn net
 * fires (reset providerSessionId + clear providerThreadId, respawn fresh).
 *
 * The invariant (ADR-100, extending ADR-049): the net arms ONLY behind a
 * pre-flight that PROVES the resume target is the culprit — i.e.
 * `resumeSessionId && hasResumeHook`. Claude Code's `hasResumableSession`
 * pre-flight clears `resumeSessionId` when nothing is resumable on disk, so by
 * the time CC can arm we KNOW a session existed but resume still crashed →
 * force-fresh loses little (the never-conversed/corrupt case, ADR-049).
 *
 * A BARE `providerThreadId` (Codex — which has NO pre-flight hook) must NOT arm
 * the net. A codex process exits 1 for many reasons unrelated to the thread;
 * force-freshing there would clear a perfectly resumable providerThreadId,
 * severing the only link to the (still-on-disk) rollout and losing the
 * conversation — the release-gating bug. Instead a Codex resume-crash falls
 * through to markExited("crashed") with the thread INTACT = retained
 * crash-but-resumable (the retain half is pinned in
 * codex-crash-retains-thread.test.ts). No loop: retain is terminal, no respawn.
 */
describe("resumeSafetyNetArmed — destructive net only behind a pre-flight", () => {
  const SID = "55555555-5555-4555-8555-555555555555";
  const TID = "66666666-6666-4666-8666-666666666666";

  it("Claude Code: armed on a real --resume (pre-flight proved the session exists)", () => {
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

  it("Codex: NOT armed by a bare providerThreadId — no pre-flight, so retain the thread (ADR-100)", () => {
    // THE FIX. Previously a bare threadId armed the net, which then cleared the
    // thread and force-respawned fresh — destroying a resumable conversation on
    // ANY immediate crash (the release-gating bug Terry hit). With no pre-flight
    // to prove the thread is the culprit, the destructive net must NOT arm; the
    // crash falls through to a retained, resumable "crashed" record instead.
    assert.equal(
      resumeSafetyNetArmed({
        resumeSessionId: SID,
        providerThreadId: TID,
        hasResumeHook: false,
      }),
      false,
    );
  });

  it("Codex: NOT armed with no thread id either (fresh spawn / already-cleared)", () => {
    assert.equal(
      resumeSafetyNetArmed({
        resumeSessionId: SID,
        providerThreadId: undefined,
        hasResumeHook: false,
      }),
      false,
    );
  });

  it("a future thread-provider WITH a pre-flight hook still arms (the gate is the pre-flight, not 'no threads')", () => {
    // Guards against re-reading the fix as "Codex/threads never arm" instead of
    // "no arming without a pre-flight." A hypothetical provider carrying BOTH a
    // resumeSessionId+hook AND a threadId arms via the proven resume path, and
    // the net's providerThreadId clear is then correct for it too.
    assert.equal(
      resumeSafetyNetArmed({
        resumeSessionId: SID,
        providerThreadId: TID,
        hasResumeHook: true,
      }),
      true,
    );
  });
});

/**
 * retainedThreadCrashNotice — the ACTIVE notice for a crashed agent whose thread
 * is retained (ADR-100). Since the fix routes Codex resume-crashes onto the
 * normal exit path (which emitted only a passive status delta), this restores an
 * actionable signal. Pinned as a pure function so the notify DECISION is covered
 * without driving a real PTY onExit (the ADR's no-live-PTY constraint).
 */
describe("retainedThreadCrashNotice — active signal for a retained crash", () => {
  it("a crashed agent WITH a retained thread gets an actionable, resumable notice", () => {
    const msg = retainedThreadCrashNotice({
      reason: "crashed",
      hasProviderThread: true,
      agentName: "codex-worker-a",
      providerDisplayName: "Codex",
    });
    assert.ok(msg, "a notice is produced");
    assert.match(msg ?? "", /codex-worker-a/);
    assert.match(msg ?? "", /Codex/);
    assert.match(msg ?? "", /resumed/i);
    assert.match(msg ?? "", /corrupt/i); // the actionable re-crash hint
  });

  it("a self-exit produces NO notice (only crashes signal)", () => {
    assert.equal(
      retainedThreadCrashNotice({
        reason: "self_exited",
        hasProviderThread: true,
        agentName: "codex-worker-a",
        providerDisplayName: "Codex",
      }),
      null,
    );
  });

  it("a crash with NO retained thread produces no notice (Claude Code unchanged)", () => {
    assert.equal(
      retainedThreadCrashNotice({
        reason: "crashed",
        hasProviderThread: false,
        agentName: "cc-worker",
        providerDisplayName: "Claude Code",
      }),
      null,
    );
  });
});

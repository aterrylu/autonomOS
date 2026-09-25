/**
 * Codex agents must survive a server/daemon restart. Two independent failures
 * (both reproduced against real codex 0.154, error text captured under node-pty):
 *  (A) `codex resume <thread> --remote` + ANY permission override exits 1:
 *      "Permission overrides are not supported when resuming a remote task."
 *      → covered in codex-daemon.test.ts (resume argv carries no overrides).
 *  (B) a never-prompted agent's thread was never saved (codex writes the rollout
 *      lazily, first turn) → "No saved session found" → the thread pre-flight
 *      starts fresh instead.
 * Plus: a resumed thread keeps its creation-time policy, so a mode change can't
 * apply on resume — the runtime must refuse it honestly, never record it.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PERMISSION_MODE_INFO,
  type ResolvedSpawnOptions,
} from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-codex-preflight-${randomUUID()}`;

const { codexProvider } = await import("../providers/codex.js");
const { _resetCodexRolloutCacheForTesting } = await import(
  "../gateway/codexRollout.js"
);
const {
  threadIsResumable,
  resumePermissionModeLock,
  resolveSpawnProvider,
  SpawnError,
} = await import("../agents/runtime.js");

const opts = (o: Partial<ResolvedSpawnOptions> = {}) =>
  ({ providerThreadId: undefined, ...o }) as ResolvedSpawnOptions;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  process.env.CODEX_HOME = home;
  _resetCodexRolloutCacheForTesting();
});
afterEach(() => {
  delete process.env.CODEX_HOME;
  _resetCodexRolloutCacheForTesting();
  rmSync(home, { recursive: true, force: true });
});
/** A rollout exactly where codex 0.154 writes it. */
function saveRollout(threadId: string): void {
  const dir = join(home, "sessions", "2026", "09", "24");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-09-24T00-00-00-${threadId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: threadId } })}\n`,
  );
}

describe("codexProvider.hasResumableThread (B: never-prompted thread)", () => {
  it("true when codex saved the thread (a rollout exists)", () => {
    const tid = "01a0d253-434c-7091-be37-bd2e0f0227c3";
    saveRollout(tid);
    assert.equal(
      codexProvider.hasResumableThread?.(
        opts({ providerThreadId: tid }),
        process.env,
      ),
      true,
    );
  });
  it("false when the thread was never saved (no turns → no rollout)", () => {
    assert.equal(
      codexProvider.hasResumableThread?.(
        opts({ providerThreadId: "01a0d241-faf8-7930-a36e-a823d15165e2" }),
        process.env,
      ),
      false,
    );
  });
  it("false with no thread id at all", () => {
    assert.equal(
      codexProvider.hasResumableThread?.(opts(), process.env),
      false,
    );
  });
  it("does NOT implement hasResumableSession — so ADR-100's force-fresh net stays disarmed", () => {
    assert.equal(codexProvider.hasResumableSession, undefined);
  });
});

describe("threadIsResumable (runtime pre-flight decision)", () => {
  const tid = "thread-1";
  it("provider without the hook → resume as before", () => {
    assert.equal(
      threadIsResumable({ displayName: "X" }, opts({ providerThreadId: tid })),
      true,
    );
  });
  it("hook says nothing saved → start fresh", () => {
    assert.equal(
      threadIsResumable(
        { displayName: "Codex", hasResumableThread: () => false },
        opts({ providerThreadId: tid }),
      ),
      false,
    );
  });
  it("probe THROWS → fail open (resume; retain-on-crash is the backstop)", () => {
    assert.equal(
      threadIsResumable(
        {
          displayName: "Codex",
          hasResumableThread: () => {
            throw new Error("EIO");
          },
        },
        opts({ providerThreadId: tid }),
      ),
      true,
    );
  });
  it("no thread → nothing to decide", () => {
    assert.equal(
      threadIsResumable(
        { displayName: "Codex", hasResumableThread: () => false },
        opts(),
      ),
      true,
    );
  });
});

describe("codexProvider.resumeCannotApplyModeChange", () => {
  const f = codexProvider.resumeCannotApplyModeChange!;
  it("a change that alters the Codex policy cannot apply on resume", () => {
    assert.equal(f("ask", "bypass"), true);
    assert.equal(f("bypass", "ask"), true);
  });
  it("modes that map to the same Codex policy are not a real change", () => {
    assert.equal(f("ask", "plan"), false); // plan is clamped to ask on Codex
    assert.equal(f("bypass", "bypass"), false);
  });
});

describe("resumePermissionModeLock", () => {
  const cannot = (a: string, b: string) => a !== b;
  const base = {
    isReattach: true,
    resumingThread: true,
    current: "ask" as const,
    cannotApply: cannot,
  };
  it("LOCKS a change the resumed conversation can't apply — record keeps the running mode", () => {
    assert.deepEqual(
      resumePermissionModeLock({ ...base, requested: "bypass" }),
      {
        locked: true,
        effective: "ask",
      },
    );
  });
  it("no change requested → no lock", () => {
    assert.deepEqual(resumePermissionModeLock({ ...base, requested: "ask" }), {
      locked: false,
      effective: "ask",
    });
  });
  it("a FRESH thread (pre-flight cleared it) takes the new mode — nothing to keep", () => {
    assert.equal(
      resumePermissionModeLock({
        ...base,
        resumingThread: false,
        requested: "bypass",
      }).effective,
      "bypass",
    );
  });
  it("providers that CAN apply a change on resume (no hook) are unaffected", () => {
    assert.equal(
      resumePermissionModeLock({
        ...base,
        cannotApply: undefined,
        requested: "bypass",
      }).effective,
      "bypass",
    );
  });
  it("a fresh spawn / adopt is never locked", () => {
    assert.equal(
      resumePermissionModeLock({
        ...base,
        isReattach: false,
        requested: "bypass",
      }).locked,
      false,
    );
  });
});

describe("resolveSpawnProvider — a reattach runs the RECORD's provider", () => {
  const codexRec = { provider: "codex" as const, name: "codex-worker-a" };
  it("an omitted provider on a Codex reattach stays Codex (was: silently became claude-code)", () => {
    assert.equal(resolveSpawnProvider(undefined, codexRec), "codex");
  });
  it("the same provider repeated is fine", () => {
    assert.equal(resolveSpawnProvider("codex", codexRec), "codex");
  });
  it("a CONTRADICTING provider is refused (409), never silently switched", () => {
    assert.throws(
      () => resolveSpawnProvider("claude-code", codexRec),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.code === "PROVIDER_MISMATCH" &&
        e.status === 409,
    );
  });
  it("a new spawn uses the request, else the default", () => {
    assert.equal(resolveSpawnProvider("gemini-cli", undefined), "gemini-cli");
    assert.equal(resolveSpawnProvider(undefined, undefined), "claude-code");
  });
});

describe("Codex auto/plan are HONEST (clamped, and the copy never claims Codex lacks them)", () => {
  it("auto maps to on-request like ask — never the removed on-failure, never wider", () => {
    const args = codexProvider.buildArgs(
      opts({
        sidecarEndpoint: "ws://127.0.0.1:1",
        permissionMode: "auto",
      }) as ResolvedSpawnOptions,
    );
    assert.ok(args.includes('approval_policy="on-request"'));
    assert.ok(!args.some((a) => a.includes("on-failure")));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  });
  it("auto and plan get a user-facing clamp notice; native modes don't", () => {
    assert.match(
      codexProvider.clampedModeNotice?.("auto") ?? "",
      /behaves like Ask.*Bypass/,
    );
    assert.match(
      codexProvider.clampedModeNotice?.("plan") ?? "",
      /behaves like Ask/,
    );
    assert.equal(codexProvider.clampedModeNotice?.("ask"), undefined);
    assert.equal(codexProvider.clampedModeNotice?.("bypass"), undefined);
  });
  it("pins the exact notices — they say 'not wired up', never 'Codex has no …'", () => {
    // Codex 0.154 HAS both: a Plan collaboration mode and automatic approval
    // review (approvals_reviewer=auto_review). autonomOS just doesn't wire them
    // up. A notice claiming otherwise shipped once (#398) — pin the truth.
    assert.equal(
      codexProvider.clampedModeNotice?.("auto"),
      "Codex's auto review isn't wired up in autonomOS yet, so this agent behaves like Ask. Pick Bypass for no approvals.",
    );
    assert.equal(
      codexProvider.clampedModeNotice?.("plan"),
      "Codex's plan mode isn't wired up in autonomOS yet, so this agent behaves like Ask.",
    );
    const userFacing = [
      codexProvider.clampedModeNotice?.("auto"),
      codexProvider.clampedModeNotice?.("plan"),
      PERMISSION_MODE_INFO.auto.perProvider.codex,
      PERMISSION_MODE_INFO.plan.perProvider.codex,
    ];
    for (const text of userFacing) {
      assert.doesNotMatch(text ?? "", /has no|no auto tier|no plan mode/i);
    }
  });
  it("ask ↔ auto is not a real change on resume (same Codex policy)", () => {
    assert.equal(
      codexProvider.resumeCannotApplyModeChange?.("ask", "auto"),
      false,
    );
  });
});

describe("C1: the probe NEVER turns can't-tell into 'never saved'", () => {
  it("an unreadable sessions tree THROWS (runtime then resumes) — not 'absent'", (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads anything");
    const day = join(home, "sessions", "2026", "09", "24");
    mkdirSync(day, { recursive: true });
    chmodSync(join(home, "sessions", "2026"), 0o000);
    try {
      assert.throws(() =>
        codexProvider.hasResumableThread?.(
          opts({ providerThreadId: "t-x" }),
          process.env,
        ),
      );
      // …and the runtime decision therefore fails OPEN (resume):
      assert.equal(
        threadIsResumable(
          codexProvider,
          opts({ providerThreadId: "t-x" }),
          process.env,
        ),
        true,
      );
    } finally {
      chmodSync(join(home, "sessions", "2026"), 0o755);
    }
  });

  it("no sessions dir at all = cleanly 'absent' (codex never saved anything here)", () => {
    assert.equal(
      codexProvider.hasResumableThread?.(
        opts({ providerThreadId: "t-y" }),
        process.env,
      ),
      false,
    );
  });

  it("probes the AGENT's CODEX_HOME, not the server's", () => {
    const tid = "01a0d253-434c-7091-be37-bd2e0f0227c3";
    const agentHome = mkdtempSync(join(tmpdir(), "agent-codex-home-"));
    try {
      const dir = join(agentHome, "sessions", "2026", "09", "24");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-x-${tid}.jsonl`), "{}\n");
      // server's CODEX_HOME (home) has nothing; the agent's does:
      assert.equal(
        codexProvider.hasResumableThread?.(opts({ providerThreadId: tid }), {
          CODEX_HOME: agentHome,
        }),
        true,
      );
    } finally {
      rmSync(agentHome, { recursive: true, force: true });
    }
  });
});

describe("H2: the mode a resumed thread ACTUALLY runs (from its turn_context)", () => {
  function rolloutWithPolicy(tid: string, policy: string): void {
    const dir = join(home, "sessions", "2026", "09", "24");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-x-${tid}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: { approval_policy: policy, sandbox_policy: { type: "danger-full-access" } } })}\n`,
    );
  }
  it("record says ask but the thread runs never → corrected to bypass (was silently WIDER)", () => {
    rolloutWithPolicy("t-bp", "never");
    assert.equal(
      codexProvider.resumedThreadMode?.(
        opts({ providerThreadId: "t-bp" }),
        process.env,
        "ask",
      ),
      "bypass",
    );
  });
  it("record says bypass but the thread runs on-request → corrected to ask (was silently narrower)", () => {
    rolloutWithPolicy("t-ask", "on-request");
    assert.equal(
      codexProvider.resumedThreadMode?.(
        opts({ providerThreadId: "t-ask" }),
        process.env,
        "bypass",
      ),
      "ask",
    );
  });
  it("a consistent record (incl. auto/plan ≡ on-request) is left alone", () => {
    rolloutWithPolicy("t-ok", "on-request");
    for (const m of ["ask", "auto", "plan"] as const)
      assert.equal(
        codexProvider.resumedThreadMode?.(
          opts({ providerThreadId: "t-ok" }),
          process.env,
          m,
        ),
        undefined,
      );
  });
  it("unreadable / no rollout → no correction (never guess)", () => {
    assert.equal(
      codexProvider.resumedThreadMode?.(
        opts({ providerThreadId: "t-none" }),
        process.env,
        "ask",
      ),
      undefined,
    );
  });
});

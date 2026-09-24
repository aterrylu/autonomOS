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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-codex-preflight-${randomUUID()}`;

const { codexProvider } = await import("../providers/codex.js");
const { _resetCodexRolloutCacheForTesting } = await import(
  "../gateway/codexRollout.js"
);
const { threadIsResumable, resumePermissionModeLock } = await import(
  "../agents/runtime.js"
);

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
      codexProvider.hasResumableThread?.(opts({ providerThreadId: tid })),
      true,
    );
  });
  it("false when the thread was never saved (no turns → no rollout)", () => {
    assert.equal(
      codexProvider.hasResumableThread?.(
        opts({ providerThreadId: "01a0d241-faf8-7930-a36e-a823d15165e2" }),
      ),
      false,
    );
  });
  it("false with no thread id at all", () => {
    assert.equal(codexProvider.hasResumableThread?.(opts()), false);
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

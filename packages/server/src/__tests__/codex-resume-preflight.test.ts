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
  completePermission,
  PERMISSION_MODE_INFO,
  permissionFromLegacyMode,
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
  resumePermissionLock,
  requestedPermission,
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

const cx = (v: Record<string, string> = {}) => completePermission("codex", v);

describe("codexProvider.resumeCannotApplyChange", () => {
  const f = codexProvider.resumeCannotApplyChange!;
  it("a change on an axis the thread keeps from creation cannot apply on resume", () => {
    assert.equal(f(cx(), cx({ approval_policy: "never" })), true);
    assert.equal(f(cx({ approval_policy: "never" }), cx()), true);
    assert.equal(f(cx(), cx({ sandbox_mode: "workspace-write" })), true);
    assert.equal(f(cx(), cx({ approvals_reviewer: "auto_review" })), true);
  });
  it("identical settings are not a change", () => {
    assert.equal(f(cx(), cx()), false);
    assert.equal(
      f(cx({ approval_policy: "never" }), cx({ approval_policy: "never" })),
      false,
    );
  });
});

describe("resumePermissionLock", () => {
  const base = {
    isReattach: true,
    resumingThread: true,
    current: cx(),
    cannotApply: () => true,
  };
  const never = cx({ approval_policy: "never" });
  it("LOCKS a change the resumed conversation can't apply — record keeps the running setting", () => {
    assert.deepEqual(resumePermissionLock({ ...base, requested: never }), {
      locked: true,
      effective: cx(),
    });
  });
  it("no change requested → no lock (compared by VALUE, not identity)", () => {
    assert.deepEqual(resumePermissionLock({ ...base, requested: cx() }), {
      locked: false,
      effective: cx(),
    });
  });
  it("a FRESH thread (pre-flight cleared it) takes the new setting — nothing to keep", () => {
    assert.deepEqual(
      resumePermissionLock({ ...base, resumingThread: false, requested: never })
        .effective,
      never,
    );
  });
  it("providers that CAN apply a change on resume (no hook) are unaffected", () => {
    assert.deepEqual(
      resumePermissionLock({
        ...base,
        cannotApply: undefined,
        requested: never,
      }).effective,
      never,
    );
  });
  it("a fresh spawn / adopt is never locked", () => {
    assert.equal(
      resumePermissionLock({ ...base, isReattach: false, requested: never })
        .locked,
      false,
    );
  });
});

describe("requestedPermission — what the caller asked for, in the runtime's values", () => {
  it("nothing asked = undefined (ADR-061: never collapse to a default here)", () => {
    assert.equal(requestedPermission("codex", undefined, undefined), undefined);
  });
  it("a legacy mode maps to exactly what it always ran", () => {
    assert.deepEqual(
      requestedPermission("codex", undefined, "bypass"),
      permissionFromLegacyMode("codex", "bypass"),
    );
  });
  it("the canonical permission wins over a legacy mode", () => {
    const p = cx({ approvals_reviewer: "auto_review" });
    assert.deepEqual(requestedPermission("codex", p, "bypass"), p);
  });
  it("another runtime's values are refused (400), never reinterpreted", () => {
    assert.throws(
      () =>
        requestedPermission(
          "codex",
          completePermission("claude-code", { "permission-mode": "plan" }),
          undefined,
        ),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.code === "INVALID_PERMISSION" &&
        e.status === 400,
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

describe("Codex argv follows its canonical values (ADR-115)", () => {
  const argsFor = (v: Record<string, string>) =>
    codexProvider.buildArgs(
      opts({
        sidecarEndpoint: "ws://127.0.0.1:1",
        permission: cx(v),
      }) as ResolvedSpawnOptions,
    );
  it("the default is today's ask: on-request, no sandbox, never the removed on-failure", () => {
    const args = argsFor({});
    assert.ok(args.includes('approval_policy="on-request"'));
    assert.ok(args.includes("danger-full-access"));
    assert.ok(!args.some((a) => a.includes("on-failure")));
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  });
  it("never + danger-full-access = Codex's own all-in-one skip flag", () => {
    assert.ok(
      argsFor({ approval_policy: "never" }).includes(
        "--dangerously-bypass-approvals-and-sandbox",
      ),
    );
  });
  it("never WITH a sandbox keeps the sandbox (the skip flag would drop it)", () => {
    const args = argsFor({
      approval_policy: "never",
      sandbox_mode: "workspace-write",
    });
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(args.includes("workspace-write"));
    assert.ok(args.includes('approval_policy="never"'));
  });
  it("the reviewer is passed through in Codex's own key", () => {
    assert.ok(
      argsFor({ approvals_reviewer: "auto_review" }).includes(
        'approvals_reviewer="auto_review"',
      ),
    );
  });
  it("legacy auto/plan run exactly what ask runs (what they always ran)", () => {
    for (const m of ["auto", "plan"] as const) {
      const args = codexProvider.buildArgs(
        opts({
          sidecarEndpoint: "ws://127.0.0.1:1",
          permissionMode: m,
        }) as ResolvedSpawnOptions,
      );
      assert.deepEqual(args, argsFor({}), m);
    }
  });
  it("the copy never claims Codex lacks auto review / plan", () => {
    for (const text of [
      PERMISSION_MODE_INFO.auto.perProvider.codex,
      PERMISSION_MODE_INFO.plan.perProvider.codex,
    ]) {
      assert.doesNotMatch(text ?? "", /has no|no auto tier|no plan mode/i);
    }
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

describe("H2: the permission a resumed thread ACTUALLY runs (from its turn_context)", () => {
  function rollout(tid: string, ctx: Record<string, unknown>): void {
    const dir = join(home, "sessions", "2026", "09", "24");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-x-${tid}.jsonl`),
      `${JSON.stringify({ type: "turn_context", payload: ctx })}\n`,
    );
  }
  const ran = (policy: string, sandbox = "danger-full-access") => ({
    approval_policy: policy,
    sandbox_policy: { type: sandbox },
  });
  const probe = (tid: string, record = cx()) =>
    codexProvider.resumedThreadPermission?.(
      opts({ providerThreadId: tid }),
      process.env,
      record,
    );
  it("record says on-request but the thread runs never → corrected (was silently WIDER)", () => {
    rollout("t-bp", ran("never"));
    assert.deepEqual(probe("t-bp"), cx({ approval_policy: "never" }));
  });
  it("record says never but the thread runs on-request → corrected (was silently narrower)", () => {
    rollout("t-ask", ran("on-request"));
    assert.deepEqual(probe("t-ask", cx({ approval_policy: "never" })), cx());
  });
  it("a different SANDBOX is corrected too — the thread keeps it", () => {
    rollout("t-sb", ran("on-request", "workspace-write"));
    assert.deepEqual(probe("t-sb"), cx({ sandbox_mode: "workspace-write" }));
  });
  it("a consistent record is left alone", () => {
    rollout("t-ok", ran("on-request"));
    assert.equal(probe("t-ok"), undefined);
  });
  it("a value we don't know → no correction (never guess)", () => {
    rollout("t-odd", ran("granular-thing"));
    assert.equal(probe("t-odd"), undefined);
  });
  it("unreadable / no rollout → no correction (never guess)", () => {
    assert.equal(probe("t-none"), undefined);
  });
});

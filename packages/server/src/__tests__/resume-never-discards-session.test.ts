/**
 * A resume whose session EXISTS on disk must never be thrown away, however
 * fast it dies. It used to: a pre-flight-gated resume that exited non-zero
 * within 5s had its providerSessionId regenerated and was started fresh,
 * losing the conversation. The usual fast death is the start-up, not the
 * session: an agent whose cwd is the home directory sees the trust dialog on
 * every start, and a reset selection answered it "No, exit". Now the same
 * resume is retried (bounded) and then left stopped with the session intact.
 * Drives the REAL spawnAgent and exit handler with a stub that exits at once.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type {
  AgentProvider,
  ResolvedSpawnOptions,
  UUID,
} from "@autonomos/core";
import { isolateHome } from "./helpers/isolate-home.js";

// The fake spreads claudeCodeProvider, so the real pre-trust runs: isolate
// BEFORE any server import.
const isolated = isolateHome("aos-rnd");
const CONFIG_DIR = `/tmp/aos-rnd-${randomUUID()}`;
process.env.AUTONOMOS_CONFIG_DIR = CONFIG_DIR;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53931);
setAuthToken("test-token-rnd-abcdef0123");
setInternalSocketPath(
  join(tmpdir(), `aos-rnd-${randomUUID().slice(0, 8)}.sock`),
);
const {
  spawnAgent,
  killAttachment,
  resumeFailureAction,
  _setResumeRetryBackoffForTesting,
  _setResumeRetrySchedulerForTesting,
  getAttachment,
} = await import("../agents/runtime.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { claudeCodeProvider } = await import("../providers/claude-code.js");
const {
  buildAgent,
  insertAgent,
  getAgent,
  markActivity,
  markExited,
  _resetCacheForTesting,
} = await import("../agents/store.js");
const { getNotifications, clearNotifications } = await import(
  "../routes/hooks.js"
);

const NAME = "fakeclaude-rnd";
const STUB_EXIT_DELAY = process.env.AOS_STUB_EXIT_DELAY ?? "0.15";
const cwd = mkdtempSync(join(tmpdir(), "aos-rnd-"));
let seen: ResolvedSpawnOptions[] = [];
/** "settle" = a watcher that reports its dialogs out of the way at once;
 *  "never" = one still waiting on a dialog when the agent dies. */
let watcher: "none" | "settle" | "never" = "none";

const fake: AgentProvider = {
  ...claudeCodeProvider,
  name: NAME as never,
  displayName: "FakeClaude",
  resolveBinary: () => "/bin/sh",
  buildArgs: (r: ResolvedSpawnOptions) => {
    seen.push({ ...r });
    // Dies fast (well inside the 5s window), like the dialog death, but not
    // instantly: the attempt is still exiting while the test moves on, which
    // is the gate's loaded-box condition made the normal case. Raise it with
    // AOS_STUB_EXIT_DELAY to prove the waits are on state, not time.
    return ["-c", `sleep ${STUB_EXIT_DELAY}; exit 1`];
  },
  get attachStartupWatcher() {
    if (watcher === "none") return undefined;
    return (_pty: unknown, _opts: unknown, onSettled?: () => void) => {
      if (watcher === "settle") setTimeout(() => onSettled?.(), 0);
    };
  },
  hasResumableSession: () => true, // the transcript EXISTS
} as AgentProvider;

const ids: string[] = [];
function seed(): UUID {
  const id = randomUUID() as UUID;
  ids.push(id);
  insertAgent(
    buildAgent({
      id,
      name: `rnd-${id.slice(0, 4)}`,
      workingDirectory: cwd,
      provider: NAME as never,
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  markActivity(id, Date.now() - 60_000);
  markExited(id, "user_killed");
  return id;
}

async function until(
  pred: () => boolean,
  what: string,
  ms = 5_000,
): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Retries are queued here and fired by the test, never by a clock. */
interface QueuedRetry {
  fire: () => void;
  cancelled: boolean;
  fired: boolean;
}
let queue: QueuedRetry[] = [];
const scheduler = {
  schedule: (fire: () => void): QueuedRetry => {
    const q = { fire, cancelled: false, fired: false };
    queue.push(q);
    return q;
  },
  cancel: (h: unknown) => {
    (h as QueuedRetry).cancelled = true;
  },
};

/** Wait until attempt `n` has fully exited and queued its retry. */
async function retryQueued(id: string, n: number): Promise<void> {
  await until(
    () => queue.length >= n && !getAttachment(id as UUID),
    `retry #${n} queued after the attempt exited`,
    15_000,
  );
}
/** Fire retry #n (1-based) the way its timer would. */
function fireRetry(n: number): void {
  const q = queue[n - 1];
  assert.ok(q, `retry #${n} exists`);
  if (q.cancelled) return;
  q.fired = true;
  q.fire();
}
/** Wait until the agent ended stopped (all attempts exited). */
async function ended(id: string): Promise<void> {
  await until(
    () =>
      getAgent(id as UUID)?.status === "exited" && !getAttachment(id as UUID),
    "the agent ended stopped",
    15_000,
  );
}

beforeEach(() => {
  _setProviderForTesting(NAME, fake);
  _setResumeRetrySchedulerForTesting(scheduler);
  queue = [];
  seen = [];
  watcher = "none";
});
afterEach(() => {
  for (const id of ids.splice(0)) {
    killAttachment(id as UUID);
    clearNotifications(id);
  }
  _setResumeRetrySchedulerForTesting(null);
  _setResumeRetryBackoffForTesting(null);
});
after(() => {
  _resetCacheForTesting();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  isolated.restore();
});

describe("a resumable session is never discarded by a fast exit", () => {
  it("retries the SAME session, then stops with it intact and says so", async () => {
    const id = seed();
    const original = getAgent(id)?.providerSessionId;
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await retryQueued(id, 1);
    fireRetry(1);
    await retryQueued(id, 2);
    fireRetry(2);
    await ended(id);
    assert.equal(seen.length, 3, "one resume and two retries");
    for (const r of seen) {
      assert.equal(r.providerSessionId, original, "never a new session id");
      assert.equal(r.resumeSessionId, original, "each attempt RESUMES it");
    }
    const rec = getAgent(id);
    assert.equal(rec?.providerSessionId, original, "record keeps the session");
    assert.equal(rec?.exitReason, "crashed");
    const notes = getNotifications(id).map((n) => n.message ?? "");
    assert.ok(
      notes.some((m) => /session is intact and was not replaced/.test(m)),
      `got: ${JSON.stringify(notes)}`,
    );
    assert.ok(!notes.some((m) => /starting fresh/.test(m)));
  });

  it("a death while a startup dialog was still up is reported as that", async () => {
    watcher = "never";
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await retryQueued(id, 1);
    fireRetry(1);
    await retryQueued(id, 2);
    fireRetry(2);
    await ended(id);
    const notes = getNotifications(id).map((n) => n.message ?? "");
    assert.ok(notes.some((m) => /startup dialog was still on screen/.test(m)));
  });

  it("a kill during the retry backoff wins: no respawn behind the operator's back", async () => {
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await retryQueued(id, 1);
    killAttachment(id as UUID);
    markExited(id, "user_killed");
    fireRetry(1); // the timer fires after the kill: it must stand down
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1, "no retry after the kill");
    assert.equal(getAttachment(id as UUID), undefined);
  });

  it("a kill during the backoff resets the count: the next resume gets every retry", async () => {
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await retryQueued(id, 1);
    killAttachment(id as UUID);
    markExited(id, "user_killed");
    fireRetry(1); // stands down and resets the count
    seen = [];
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id }); // the operator restarts it
    await retryQueued(id, 2);
    fireRetry(2);
    await retryQueued(id, 3);
    fireRetry(3);
    await ended(id);
    assert.equal(
      seen.length,
      3,
      "1 resume + BOTH retries, not a run shortened by the stale count",
    );
  });
});

describe("a human restart during a retry backoff owns the agent", () => {
  it("cancels the pending retry and gets a FULL retry run of its own", async () => {
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await retryQueued(id, 1); // first attempt exited; its retry is pending
    // The operator restarts it; this run dies fast too.
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(
      queue[0].cancelled,
      true,
      "the restart cancelled the pending retry",
    );
    await retryQueued(id, 2);
    fireRetry(1); // the stale timer's moment: cancelled, so nothing happens
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 2, "no attempt from the cancelled retry");
    fireRetry(2);
    await retryQueued(id, 3);
    fireRetry(3);
    await ended(id);
    // 1 (first) + the restart's own run: 1 resume + 2 retries.
    assert.equal(seen.length, 4, `attempts: ${seen.length}`);
    const giveUps = getNotifications(id).filter((n) =>
      /session is intact and was not replaced/.test(n.message ?? ""),
    );
    assert.equal(giveUps.length, 1, "one give-up, for the restart's run");
  });
});

describe("resumeFailureAction (pure)", () => {
  const base = {
    attemptedResume: true,
    lifetimeMs: 200,
    exitCode: 1,
    shuttingDown: false,
    startupSettled: true,
    retriesSoFar: 0,
  };
  it("has no start-fresh outcome: retry, retry, then give up", () => {
    const kinds = [0, 1, 2].map(
      (n) => resumeFailureAction({ ...base, retriesSoFar: n }).kind,
    );
    assert.deepEqual(kinds, ["retry", "retry", "give-up"]);
  });
  it("only a fast, failing, pre-flight-gated resume counts", () => {
    for (const over of [
      { attemptedResume: false },
      { lifetimeMs: 6_000 },
      { exitCode: 0 },
      { shuttingDown: true },
    ]) {
      assert.equal(resumeFailureAction({ ...base, ...over }).kind, "none");
    }
  });
  it("names a dialog death as such", () => {
    const a = resumeFailureAction({ ...base, startupSettled: false });
    assert.equal(a.kind === "retry" && a.cause, "startup-dialog");
  });
});

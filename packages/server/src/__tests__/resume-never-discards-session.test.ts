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
    return ["-c", "exit 1"]; // dies in milliseconds, like the dialog death
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

beforeEach(() => {
  _setProviderForTesting(NAME, fake);
  _setResumeRetryBackoffForTesting([30, 60]);
  seen = [];
  watcher = "none";
});
afterEach(() => {
  for (const id of ids.splice(0)) {
    killAttachment(id as UUID);
    clearNotifications(id);
  }
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
    // 1 resume + 2 retries, all with the original session.
    await until(() => getAgent(id)?.status === "exited", "agent left stopped");
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
    await until(() => getAgent(id)?.status === "exited", "agent left stopped");
    const notes = getNotifications(id).map((n) => n.message ?? "");
    assert.ok(notes.some((m) => /startup dialog was still on screen/.test(m)));
  });

  it("a kill during the retry backoff wins: no respawn behind the operator's back", async () => {
    _setResumeRetryBackoffForTesting([300, 300]);
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await until(() => seen.length === 1, "first attempt");
    await new Promise((r) => setTimeout(r, 50)); // inside the backoff
    killAttachment(id as UUID);
    markExited(id, "user_killed");
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(seen.length, 1, "no retry after the kill");
  });

  it("a kill during the backoff resets the count: the next resume gets every retry", async () => {
    _setResumeRetryBackoffForTesting([150, 150]);
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await until(() => seen.length === 1, "first attempt");
    await new Promise((r) => setTimeout(r, 30)); // inside the first backoff
    killAttachment(id as UUID);
    markExited(id, "user_killed");
    await new Promise((r) => setTimeout(r, 300)); // the timer fires and bails
    seen = [];
    _setResumeRetryBackoffForTesting([20, 20]);
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id }); // the operator restarts it
    await until(
      () => getAgent(id)?.status === "exited" && seen.length >= 3,
      "a full retry run",
      5_000,
    );
    assert.equal(
      seen.length,
      3,
      "1 resume + BOTH retries, not a run shortened by the stale count",
    );
  });
});

describe("a human restart during a retry backoff owns the agent", () => {
  it("cancels the pending retry and gets a FULL retry run of its own", async () => {
    _setResumeRetryBackoffForTesting([300, 300]);
    const id = seed();
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await until(() => seen.length === 1, "first attempt died, retry pending");
    await new Promise((r) => setTimeout(r, 50)); // inside the 300ms backoff
    // The operator restarts it; this run dies fast too. Its OWN first retry
    // waits 1.5s, so any attempt sooner than that is the stale timer firing.
    _setResumeRetryBackoffForTesting([1_500, 20]);
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    await until(() => seen.length === 2, "the restart's attempt");
    await new Promise((r) => setTimeout(r, 600)); // the stale 300ms timer would fire here
    assert.equal(seen.length, 2, "no attempt from the cancelled retry timer");
    await until(
      () => getAgent(id)?.status === "exited",
      "the restart's run ended",
      5_000,
    );
    await new Promise((r) => setTimeout(r, 400)); // any stale timer would fire by now
    // 1 (first) + the restart's own run: 1 resume + 2 retries. No extra
    // attempt from the cancelled timer, and no shortened run.
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * The boot resume sweep must never crash a LIVE agent.
 *
 * The agent-spawn-prompt CI flake: from the control-socket bind on, POST
 * /api/agents can spawn a fresh live agent, and the boot sweep used to list the
 * store only after several awaited imports. A spawn landing in that window was
 * "resumed" → spawnAgent threw "already attached" → the catch called
 * markExited(crashed) → the per-agent token was revoked, so the still-running
 * process had every hook rejected and the test saw zero hook events for 180s.
 *
 * Pinned here without a real `claude`: live agents are synthetic attachments
 * (FakePty); a NOT-live agent the sweep must not touch gets a working directory
 * that does not exist, so any wrongful respawn fails fast on the cwd check and
 * shows up as status "exited" instead of launching a process.
 */
const DIR = join(tmpdir(), `autonomos-boot-resume-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = DIR;

type Store = typeof import("../agents/store.js");
type Runtime = typeof import("../agents/runtime.js");
type Creds = typeof import("../agentCredentials.js");

let store: Store;
let runtime: Runtime;
let creds: Creds;
let FakePty: typeof import("../perf/fake-pty.js").FakePty;
const registered: string[] = [];

function mkAgent(name: string, workingDirectory = "/tmp") {
  return store.insertAgent(
    store.buildAgent({
      id: randomUUID(),
      name,
      workingDirectory,
      provider: "claude-code",
      providerSessionId: randomUUID(),
      permissionMode: "ask",
    }),
  ); // buildAgent defaults status: "running"
}

function makeLive(id: string) {
  runtime._registerSyntheticAttachment(id as never, new FakePty().asIPty());
  registered.push(id);
}

describe("boot resume sweep never crashes a live agent", () => {
  before(async () => {
    store = await import("../agents/store.js");
    runtime = await import("../agents/runtime.js");
    creds = await import("../agentCredentials.js");
    ({ FakePty } = await import("../perf/fake-pty.js"));
  });

  beforeEach(() => {
    for (const id of registered.splice(0))
      runtime._unregisterSyntheticAttachment(id as never);
  });

  after(async () => {
    for (const id of registered.splice(0))
      runtime._unregisterSyntheticAttachment(id as never);
    const { rmSync } = await import("node:fs");
    rmSync(DIR, { recursive: true, force: true });
  });

  it("a live agent in the sweep's list keeps running with its token valid", async () => {
    const a = mkAgent(`live-${randomUUID().slice(0, 6)}`);
    makeLive(a.id);
    const token = creds.mintAgentToken(a.id);
    // Precondition, asserted rather than assumed: the fixture is what the sweep
    // will see — persisted running AND live.
    assert.equal(store.getAgent(a.id)?.status, "running");
    assert.equal(runtime.isAgentLive(a.id as never), true);

    await runtime.resumeActiveAgents([a]);

    assert.equal(
      store.getAgent(a.id)?.status,
      "running",
      "the sweep must not mark a live agent exited",
    );
    assert.equal(
      creds.verifyAgentToken(a.id, token),
      true,
      "the sweep must not revoke a live agent's token (its hooks would all be rejected)",
    );
  });

  it("an agent created after the snapshot is not swept up", async () => {
    const snapshot = runtime.snapshotResumableAgents();
    // Created after the snapshot, not live: stands in for a spawn that raced
    // the boot sweep. With a nonexistent cwd, a wrongful respawn fails fast and
    // would show as status "exited".
    const late = mkAgent(
      `late-${randomUUID().slice(0, 6)}`,
      `/nonexistent-aos-${randomUUID()}`,
    );
    assert.ok(
      !snapshot.some((s) => s.id === late.id),
      "precondition: the late agent is not in the snapshot",
    );

    await runtime.resumeActiveAgents(snapshot);

    assert.equal(
      store.getAgent(late.id)?.status,
      "running",
      "an agent created after the snapshot must be left alone by the sweep",
    );
    // Clean up so later tests' default snapshot doesn't carry it.
    store.markExited(late.id, "user_killed");
  });

  it("markCrashedUnlessLive leaves a live agent running and token intact", () => {
    const a = mkAgent(`guard-live-${randomUUID().slice(0, 6)}`);
    makeLive(a.id);
    const token = creds.mintAgentToken(a.id);

    const updated = runtime.markCrashedUnlessLive(a.id as never, "test");

    assert.equal(updated, undefined, "skipped: returns undefined");
    assert.equal(store.getAgent(a.id)?.status, "running");
    assert.equal(creds.verifyAgentToken(a.id, token), true);
  });

  it("markCrashedUnlessLive still crashes an agent that is not live", () => {
    const a = mkAgent(`guard-dead-${randomUUID().slice(0, 6)}`);
    assert.equal(runtime.isAgentLive(a.id as never), false);

    const updated = runtime.markCrashedUnlessLive(a.id as never, "test");

    assert.equal(updated?.status, "exited");
    assert.equal(updated?.exitReason, "crashed");
  });
});

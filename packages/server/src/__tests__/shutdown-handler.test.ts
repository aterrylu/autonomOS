/**
 * createShutdownHandler — the server exits only AFTER its agents' sidecar
 * daemons have exited (bounded), never in the same tick as the teardown.
 *
 * Exiting in the same tick was the bug: a Codex daemon mid-turn ignores
 * SIGTERM, its SIGKILL escalation is a timer in the server process, and
 * process.exit() pre-empted it — orphaning the daemon, which kept running the
 * agent's turn with no server above it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createShutdownHandler } from "../shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function rig(daemonExits: Promise<void>[], capMs = 10_000) {
  const calls: string[] = [];
  const handler = createShutdownHandler({
    stopWork: () => calls.push("stopWork"),
    teardownAgents: () => {
      calls.push("teardownAgents");
      return daemonExits;
    },
    exitProcess: () => calls.push("exitProcess"),
    capMs,
  });
  return { calls, handler };
}

describe("createShutdownHandler", () => {
  it("does not exit until every daemon has exited", async () => {
    const a = deferred();
    const b = deferred();
    const { calls, handler } = rig([a.promise, b.promise]);
    handler();
    assert.deepEqual(calls, ["stopWork", "teardownAgents"]);

    a.resolve();
    await tick();
    assert.ok(!calls.includes("exitProcess"), "exited with a daemon alive");

    b.resolve();
    await tick();
    assert.deepEqual(calls, ["stopWork", "teardownAgents", "exitProcess"]);
  });

  it("exits promptly when there are no daemons", async () => {
    const { calls, handler } = rig([]);
    handler();
    await tick();
    assert.deepEqual(calls, ["stopWork", "teardownAgents", "exitProcess"]);
  });

  it("exits at the cap when a daemon never exits", async () => {
    const { calls, handler } = rig([new Promise(() => {})], 50);
    handler();
    await tick();
    assert.ok(!calls.includes("exitProcess"));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.at(-1), "exitProcess");
  });

  it("a second signal exits now, and exit still happens exactly once", async () => {
    const d = deferred();
    const { calls, handler } = rig([d.promise]);
    handler();
    handler();
    assert.deepEqual(calls, ["stopWork", "teardownAgents", "exitProcess"]);

    d.resolve();
    await tick();
    assert.equal(calls.filter((c) => c === "exitProcess").length, 1);
    assert.equal(calls.filter((c) => c === "teardownAgents").length, 1);
  });
});

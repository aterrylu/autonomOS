/**
 * createShutdownHandler — the server exits only AFTER its agents' sidecar
 * daemons have exited (bounded), never in the same tick as the teardown.
 * Regression for the orphaned mid-turn daemon — see stopAllSidecars.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createShutdownHandler, type ShutdownSteps } from "../shutdown.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rig(overrides: Partial<ShutdownSteps> = {}) {
  const calls: string[] = [];
  const daemons = deferred<number[]>();
  const handler = createShutdownHandler({
    stopWork: () => calls.push("stopWork"),
    teardownAgents: () => {
      calls.push("teardownAgents");
    },
    awaitDaemons: () => {
      calls.push("awaitDaemons");
      return daemons.promise;
    },
    exitProcess: () => calls.push("exitProcess"),
    ...overrides,
  });
  const exits = () => calls.filter((c) => c === "exitProcess").length;
  return { calls, handler, daemons, exits };
}

describe("createShutdownHandler", () => {
  it("does not exit until the daemons have exited", async () => {
    const { calls, handler, daemons } = rig();
    handler();
    await sleep(20);
    assert.deepEqual(calls, ["stopWork", "teardownAgents", "awaitDaemons"]);

    daemons.resolve([]);
    await sleep(20);
    assert.equal(calls.at(-1), "exitProcess");
  });

  it("still exits when daemons survive the bound", async () => {
    const { handler, daemons, exits } = rig();
    handler();
    daemons.resolve([4242]);
    await sleep(20);
    assert.equal(exits(), 1);
  });

  it("a repeat signal inside the grace window is a duplicate — ignored", async () => {
    const { handler, daemons, exits } = rig({ repeatGraceMs: 10_000 });
    handler();
    handler();
    await sleep(20);
    assert.equal(exits(), 0, "the duplicate skipped the daemon wait");

    daemons.resolve([]);
    await sleep(20);
    assert.equal(exits(), 1);
  });

  it("a repeat signal after the grace window exits now, and exit happens exactly once", async () => {
    const { calls, handler, daemons, exits } = rig({ repeatGraceMs: 30 });
    handler();
    await sleep(60);
    handler();
    assert.equal(exits(), 1);

    daemons.resolve([]);
    await sleep(20);
    assert.equal(exits(), 1);
    assert.equal(calls.filter((c) => c === "teardownAgents").length, 1);
  });

  it("a throwing teardown still waits for the daemons, then exits", async () => {
    const { calls, handler, daemons, exits } = rig({
      teardownAgents: () => {
        throw new Error("boom");
      },
    });
    handler();
    await sleep(20);
    assert.ok(calls.includes("awaitDaemons"));
    assert.equal(exits(), 0);

    daemons.resolve([]);
    await sleep(20);
    assert.equal(exits(), 1);
  });

  it("a rejected daemon wait still exits", async () => {
    const { handler, daemons, exits } = rig();
    handler();
    daemons.reject(new Error("boom"));
    await sleep(20);
    assert.equal(exits(), 1);
  });
});

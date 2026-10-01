/**
 * listBackgroundWork's single-flight must never pin a stale answer.
 *
 * With no running agents its body has no `await`, so an in-flight slot
 * cleared inside the body would be cleared BEFORE it was assigned — leaving
 * that first, settled promise in the slot for the life of the process: the
 * update dialog's "background work will be stopped" warning would read empty
 * forever after a first poll with nothing running.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const DIR = mkdtempSync(join(tmpdir(), "autonomos-bgwork-"));
process.env.AUTONOMOS_CONFIG_DIR = DIR;

describe("listBackgroundWork single-flight", () => {
  const realPath = process.env.PATH;
  const shimDir = join(DIR, "shim");
  const calls = join(DIR, "ps-calls");

  before(() => {
    // A `ps` that records each run, so a recompute is observable.
    mkdirSync(shimDir);
    writeFileSync(calls, "");
    writeFileSync(join(shimDir, "ps"), `#!/bin/sh\necho x >> "${calls}"\n`);
    chmodSync(join(shimDir, "ps"), 0o755);
    process.env.PATH = `${shimDir}:${realPath}`;
  });
  after(() => {
    process.env.PATH = realPath;
    rmSync(DIR, { recursive: true, force: true });
  });

  const psRuns = () =>
    readFileSync(calls, "utf8").split("\n").filter(Boolean).length;

  it("recomputes after the cache window, even if the first call had nothing running", async () => {
    const store = await import("../agents/store.js");
    const sched = await import("../upgradeScheduler.js");
    sched._resetBackgroundWorkForTesting();

    assert.deepEqual(await sched.listBackgroundWork(0), []);
    assert.equal(psRuns(), 0, "nothing running → no ps");

    store.insertAgent({
      ...store.buildAgent({
        id: randomUUID(),
        name: "bg-worker",
        workingDirectory: "/tmp",
        provider: "claude-code",
        providerSessionId: randomUUID(),
        permissionMode: "ask",
      }),
      status: "running",
    });

    await sched.listBackgroundWork(5_000); // past the 2s cache
    assert.equal(psRuns(), 1, "a running agent must trigger a fresh ps");
  });

  it("concurrent callers share one ps", async () => {
    const sched = await import("../upgradeScheduler.js");
    sched._resetBackgroundWorkForTesting();
    const before = psRuns();
    await Promise.all([
      sched.listBackgroundWork(10_000),
      sched.listBackgroundWork(10_000),
      sched.listBackgroundWork(10_000),
    ]);
    assert.equal(psRuns() - before, 1);
  });
});

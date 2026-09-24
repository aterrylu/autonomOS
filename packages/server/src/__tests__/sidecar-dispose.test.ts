/**
 * Sidecar daemon disposal: dispose() resolves on EXIT, and stopAllSidecars()
 * — what server shutdown waits on — reaps every daemon that exists, including
 * one started after its first sweep. Regression for the orphaned mid-turn
 * daemon — see stopAllSidecars.
 *
 * The stub daemons here are real child processes: one ignores SIGTERM (a hung
 * daemon — the SIGKILL backstop's case), one honors it (the normal case).
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  awaitSidecarExits,
  runningSidecarPids,
  SIDECAR_KILL_AFTER_MS,
  startSidecarDaemon,
  stopAllSidecars,
} from "../agents/sidecar.js";

const READY = "listening on ws://stub";
const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); console.log(${JSON.stringify(READY)}); setInterval(() => {}, 1000);`;
const HONORS_SIGTERM = `console.log(${JSON.stringify(READY)}); setInterval(() => {}, 1000);`;

function startStub(body: string) {
  return startSidecarDaemon(process.execPath, ["-e", body], "ws://stub", {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    readyNeedle: READY,
  });
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("Sidecar.dispose()", () => {
  it("resolves only once a SIGTERM-ignoring daemon is SIGKILLed", async () => {
    const sc = await startStub(IGNORES_SIGTERM);
    const t0 = Date.now();
    await sc.dispose();
    const elapsed = Date.now() - t0;
    assert.equal(sc.proc.signalCode, "SIGKILL");
    assert.ok(
      elapsed >= SIDECAR_KILL_AFTER_MS - 50,
      `resolved after ${elapsed}ms — before the SIGKILL escalation`,
    );
  });

  it("resolves promptly for a daemon that honors SIGTERM", async () => {
    const sc = await startStub(HONORS_SIGTERM);
    const t0 = Date.now();
    await sc.dispose();
    assert.equal(sc.proc.signalCode, "SIGTERM");
    assert.ok(Date.now() - t0 < SIDECAR_KILL_AFTER_MS);
  });

  it("is idempotent — repeat calls return the first call's promise", async () => {
    const sc = await startStub(HONORS_SIGTERM);
    const first = sc.dispose();
    assert.equal(sc.dispose(), first);
    await first;
    assert.equal(sc.dispose(), first);
  });

  it("a daemon that fails to spawn never enters the registry", async () => {
    await assert.rejects(
      startSidecarDaemon("/nonexistent/daemon", [], "ws://stub", {
        cwd: tmpdir(),
        env: {},
        readyNeedle: READY,
      }),
    );
    assert.deepEqual(runningSidecarPids(), []);
  });
});

describe("stopAllSidecars()", () => {
  it("reaps every running daemon, hung ones included", async () => {
    const a = await startStub(HONORS_SIGTERM);
    const b = await startStub(IGNORES_SIGTERM);
    assert.equal(runningSidecarPids().length, 2);

    assert.deepEqual(await stopAllSidecars(), []);
    assert.equal(isAlive(a.proc.pid as number), false);
    assert.equal(isAlive(b.proc.pid as number), false);
  });

  it("re-sweeps: a daemon started during the wait is reaped too", async () => {
    const hung = await startStub(IGNORES_SIGTERM);
    const stopping = stopAllSidecars();
    const late = await startStub(HONORS_SIGTERM);

    assert.deepEqual(await stopping, []);
    assert.equal(isAlive(hung.proc.pid as number), false);
    assert.equal(isAlive(late.proc.pid as number), false);
  });

  it("returns the pids still alive at the cap", async () => {
    const hung = await startStub(IGNORES_SIGTERM);
    // Cap below the SIGKILL escalation: the daemon is still alive at the cap.
    assert.deepEqual(await stopAllSidecars(100), [hung.proc.pid]);
    await hung.dispose();
  });
});

describe("awaitSidecarExits()", () => {
  it("resolves true with nothing to wait for", async () => {
    assert.equal(await awaitSidecarExits([]), true);
  });

  it("resolves true once every exit settles", async () => {
    assert.equal(
      await awaitSidecarExits([Promise.resolve(), Promise.resolve()]),
      true,
    );
  });

  it("gives up at the cap and resolves false", async () => {
    const t0 = Date.now();
    assert.equal(await awaitSidecarExits([new Promise(() => {})], 100), false);
    assert.ok(Date.now() - t0 < 1_000);
  });
});

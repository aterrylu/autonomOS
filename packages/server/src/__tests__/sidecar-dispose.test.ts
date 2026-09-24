/**
 * Sidecar daemon disposal — dispose() resolves on EXIT, and a shutting-down
 * server waits (bounded) for it.
 *
 * Server shutdown awaits these promises (see shutdown.ts): exiting in the
 * same tick as the SIGTERM orphaned a mid-turn Codex daemon, which then ran
 * the agent's turn to completion with no server above it.
 *
 * The stub daemons here are real child processes: one ignores SIGTERM (a hung
 * daemon — the SIGKILL backstop's case), one honors it (the normal case).
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  awaitSidecarExits,
  SIDECAR_KILL_AFTER_MS,
  startSidecarDaemon,
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

  it("is idempotent — a second call and a call after exit both resolve", async () => {
    const sc = await startStub(IGNORES_SIGTERM);
    await Promise.all([sc.dispose(), sc.dispose()]);
    assert.equal(sc.proc.signalCode, "SIGKILL");
    await sc.dispose();
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

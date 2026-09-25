/**
 * Once the server begins shutting down, nothing may start an agent — and
 * nothing may mark one crashed for it.
 *
 * Shutdown now waits (bounded) for sidecar daemons to exit instead of exiting
 * in the same tick. That wait is a window in which a racing spawn could start a
 * daemon after the teardown's sweep, which the exit would then orphan. And a
 * respawn loop (boot resume, restart-all) that runs into the refusal must stop,
 * not mark every remaining agent "crashed" — a crashed agent doesn't resume on
 * the next boot.
 *
 * The flag is one-way per process, so the cases run in order in ONE file
 * (node --test isolates each file in its own process).
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProvider, UUID } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-server-stopping-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53922);
setAuthToken("test-token-server-stopping-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-ss-${randomUUID().slice(0, 8)}.sock`),
);
const { spawnAgent, shutdownAllAttachments, resumeActiveAgents, SpawnError } =
  await import("../agents/runtime.js");
const { runningSidecarPids, stopAllSidecars } = await import(
  "../agents/sidecar.js"
);
const { _setProviderForTesting } = await import("../providers/index.js");
const { agentsRouter } = await import("../routes/agents.js");
const { codexProvider } = await import("../providers/codex.js");
const { buildAgent, insertAgent, getAgent, _resetCacheForTesting } =
  await import("../agents/store.js");

const NAME = "fakesidecar";
const cwd = mkdtempSync(join(tmpdir(), "aos-server-stopping-"));
const READY = "listening on ws://stub";

// A Codex-shaped runtime: a sidecar daemon that takes 300ms to come up (the
// window a shutdown races into), then a PTY that just idles.
const fake: AgentProvider = {
  ...codexProvider,
  name: NAME as never,
  displayName: "FakeSidecar",
  resolveBinary: () => process.execPath,
  buildSidecar: () => ({
    args: [
      "-e",
      `setTimeout(() => console.log(${JSON.stringify(READY)}), 300); setInterval(() => {}, 1000);`,
    ],
    readyNeedle: READY,
  }),
  buildArgs: () => ["-e", "setInterval(() => {}, 1000)"],
  hasResumableThread: undefined,
  resumedThreadPermission: undefined,
};
_setProviderForTesting(NAME, fake);

after(() => {
  _setProviderForTesting(NAME, null);
  _resetCacheForTesting();
});

const isStopping = (err: unknown) =>
  err instanceof SpawnError &&
  err.code === "SERVER_STOPPING" &&
  err.status === 503;

describe("server stopping", () => {
  it("a spawn racing the shutdown stops cleanly and its daemon is reaped", async () => {
    const spawning = spawnAgent({
      workingDirectory: cwd,
      provider: NAME as never,
      name: "racer",
    });
    // Wait until the daemon exists (the spawn is past its entry check and
    // awaiting readiness), then begin the shutdown inside that window.
    const t0 = Date.now();
    while (runningSidecarPids().length === 0 && Date.now() - t0 < 5_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const [daemonPid] = runningSidecarPids();
    assert.ok(daemonPid, "precondition: the racing spawn started a daemon");

    shutdownAllAttachments();
    await assert.rejects(spawning, isStopping);
    assert.deepEqual(await stopAllSidecars(), []);
    assert.throws(() => process.kill(daemonPid, 0), { code: "ESRCH" });
  });

  it("a new spawn is refused with SERVER_STOPPING (503) before it starts a daemon", async () => {
    await assert.rejects(
      spawnAgent({ workingDirectory: cwd, provider: NAME as never }),
      isStopping,
    );
    assert.deepEqual(runningSidecarPids(), []);
  });

  it("boot resume leaves 'running' agents running for the next boot — not crashed", async () => {
    const id = randomUUID() as UUID;
    insertAgent(
      buildAgent({
        id,
        name: "resume-me",
        workingDirectory: cwd,
        provider: NAME as never,
        providerSessionId: id,
        permissionMode: "ask",
        status: "running",
      }),
    );
    await resumeActiveAgents();
    assert.equal(getAgent(id)?.status, "running");
  });
  it("restart-all over HTTP answers a typed 503, not a generic 500", async () => {
    const res = await agentsRouter.request("/restart-all", { method: "POST" });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { code?: string; retryable?: boolean };
    assert.equal(body.code, "SERVER_STOPPING");
    assert.equal(body.retryable, true);
  });
});

/**
 * Single-agent restart (restartAgent / POST /api/agents/:id/restart).
 *
 * The dashboard used to restart as two client calls, kill → attach. The kill
 * only SIGNALS the old process, so the attach could respawn while it still
 * ran (two Codex daemons on one thread), and every failure was console-only in
 * the UI. These pin the server-side replacement: it waits for the old process
 * AND daemon to exit before respawning, refuses overlapping restarts, and a
 * respawn that fails leaves the agent visibly stopped, never a "running"
 * zombie.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProvider } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-restart-agent-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53927);
setAuthToken("test-token-restart-agent-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-ra-${randomUUID().slice(0, 8)}.sock`),
);
const {
  spawnAgent,
  restartAgent,
  restartAllAttachments,
  SpawnError,
  shutdownAllAttachments,
} = await import("../agents/runtime.js");
const { awaitPtyExits } = await import("../agents/ptyTerminate.js");
const { stopAllSidecars, runningSidecarPids } = await import(
  "../agents/sidecar.js"
);
const { _setProviderForTesting } = await import("../providers/index.js");
const { _resetCodexControlForTesting } = await import(
  "../gateway/codexControl.js"
);
const { codexProvider } = await import("../providers/codex.js");
const { getAgent, _resetCacheForTesting } = await import("../agents/store.js");

const cwd = mkdtempSync(join(tmpdir(), "aos-restart-agent-"));
const READY = "listening on ws://stub";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A daemon that ignores SIGTERM, so stopping it takes the SIGKILL stage (~2s):
// a restart that doesn't wait would respawn while it's still up. buildSidecar
// records, at the moment the NEW daemon is requested, which old daemons are
// still alive.
let aliveAtRespawn: number[] | undefined;
let daemonsBefore: number[] = [];
let failRespawn = false;
const hung: AgentProvider = {
  ...codexProvider,
  name: "fakerestart" as never,
  displayName: "FakeRestart",
  resolveBinary: () => {
    if (failRespawn) throw new Error("binary vanished");
    return process.execPath;
  },
  hasResumableThread: undefined,
  buildSidecar: () => {
    aliveAtRespawn = daemonsBefore.filter(alive);
    return {
      args: [
        "-e",
        `process.on("SIGTERM", () => {}); console.log(${JSON.stringify(READY)}); setInterval(() => {}, 1000);`,
      ],
      readyNeedle: READY,
    };
  },
  buildArgs: () => ["-e", "setInterval(() => {}, 1000)"],
};
_setProviderForTesting("fakerestart", hung);

after(async () => {
  _resetCodexControlForTesting();
  shutdownAllAttachments();
  await Promise.all([stopAllSidecars(), awaitPtyExits(5_000)]);
  _setProviderForTesting("fakerestart", null);
  _resetCacheForTesting();
});

describe("restartAgent", { timeout: 30_000 }, () => {
  it("waits for the OLD daemon to exit before starting the new one, and refuses overlap", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakerestart" as never,
      name: `ra-${randomUUID().slice(0, 4)}`,
    });
    daemonsBefore = runningSidecarPids();
    assert.ok(daemonsBefore.length > 0, "precondition: a daemon is running");
    aliveAtRespawn = undefined;

    const restarting = restartAgent(agent.id);
    await new Promise((r) => setTimeout(r, 100));
    // Mid-wait: the same agent, and restart-all, are both refused.
    await assert.rejects(
      restartAgent(agent.id),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.code === "RESTART_IN_PROGRESS" &&
        e.status === 409,
    );
    await assert.rejects(
      restartAllAttachments(),
      (e: unknown) => e instanceof SpawnError && e.status === 409,
    );

    const restarted = await restarting;
    assert.equal(restarted.status, "running");
    assert.deepEqual(
      aliveAtRespawn,
      [],
      "the new daemon was requested while an old one was still alive",
    );
    assert.equal(getAgent(agent.id)?.status, "running");
  });

  it("an unknown agent is a 404, not a crash", async () => {
    await assert.rejects(
      restartAgent(randomUUID() as never),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.code === "AGENT_NOT_FOUND" &&
        e.status === 404,
    );
  });

  it("a respawn that fails leaves the agent STOPPED (crashed), never a running zombie", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakerestart" as never,
      name: `ra-${randomUUID().slice(0, 4)}`,
    });
    daemonsBefore = runningSidecarPids();
    failRespawn = true;
    try {
      await assert.rejects(restartAgent(agent.id), /binary vanished/);
    } finally {
      failRespawn = false;
    }
    const rec = getAgent(agent.id);
    assert.equal(rec?.status, "exited");
    assert.equal(rec?.exitReason, "crashed");
  });
});

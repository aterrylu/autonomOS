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
  killAttachment,
  assertAdoptable,
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
const { getNotifications } = await import("../routes/hooks.js");
const { geminiCliProvider } = await import("../providers/gemini-cli.js");

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
let failRespawn: false | Error = false;
const hung: AgentProvider = {
  ...codexProvider,
  name: "fakerestart" as never,
  displayName: "FakeRestart",
  resolveBinary: () => {
    if (failRespawn) throw failRespawn;
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
    failRespawn = new Error("binary vanished");
    try {
      await assert.rejects(restartAgent(agent.id), /binary vanished/);
    } finally {
      failRespawn = false;
    }
    const rec = getAgent(agent.id);
    assert.equal(rec?.status, "exited");
    assert.equal(rec?.exitReason, "crashed");
    // …and it's SAID where it persists, not only in a toast that fades.
    assert.ok(
      getNotifications(agent.id).some((n) =>
        (n.message ?? "").includes("failed — it is stopped: binary vanished"),
      ),
    );
  });

  it("a TYPED failure after the kill (e.g. the working directory is gone) also leaves a notice", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakerestart" as never,
      name: `ra-${randomUUID().slice(0, 4)}`,
    });
    failRespawn = new SpawnError(
      "INVALID_WORKING_DIRECTORY",
      400,
      "Invalid working directory: /gone",
    );
    try {
      await assert.rejects(restartAgent(agent.id), /Invalid working directory/);
    } finally {
      failRespawn = false;
    }
    assert.equal(getAgent(agent.id)?.exitReason, "crashed");
    assert.ok(
      getNotifications(agent.id).some((n) =>
        (n.message ?? "").includes("it is stopped: Invalid working directory"),
      ),
    );
  });

  it("the server stopping mid-respawn leaves the record RUNNING (the next boot resumes it), no notice", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakerestart" as never,
      name: `ra-${randomUUID().slice(0, 4)}`,
    });
    failRespawn = new SpawnError("SERVER_STOPPING", 503, "server stopping");
    try {
      await assert.rejects(restartAgent(agent.id), /server stopping/);
    } finally {
      failRespawn = false;
    }
    assert.equal(getAgent(agent.id)?.status, "running");
    assert.ok(
      !getNotifications(agent.id).some((n) =>
        (n.message ?? "").includes("it is stopped"),
      ),
    );
  });

  it("a KILL during the restart wait wins: the agent stays stopped, nothing respawns", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakerestart" as never,
      name: `ra-${randomUUID().slice(0, 4)}`,
    });
    daemonsBefore = runningSidecarPids();
    aliveAtRespawn = undefined;
    const restarting = restartAgent(agent.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      killAttachment(agent.id),
      true,
      "the kill is accepted, not a 409",
    );
    await assert.rejects(restarting, /stopped while it restarted/);
    assert.equal(aliveAtRespawn, undefined, "no new daemon was requested");
    const rec = getAgent(agent.id);
    assert.equal(rec?.status, "exited");
    assert.equal(rec?.exitReason, "user_killed");
  });

  it("an ATTACH during the restart wait is refused (409), never spawned over the exiting process", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakerestart" as never,
      name: `ra-${randomUUID().slice(0, 4)}`,
    });
    const restarting = restartAgent(agent.id);
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(
      spawnAgent({
        workingDirectory: cwd,
        resumeAgentId: agent.id,
        provider: "fakerestart" as never,
      }),
      (e: unknown) =>
        e instanceof SpawnError &&
        e.code === "RESTART_IN_PROGRESS" &&
        e.status === 409,
    );
    assert.equal((await restarting).status, "running");
  });

  it("Gemini's resume pre-flight doesn't make it ADOPTABLE (adopt is its own capability)", () => {
    assert.throws(
      () =>
        assertAdoptable(
          geminiCliProvider,
          "6579618b-70f4-4830-9c63-646b23b7f3d9",
        ),
      (e: unknown) => e instanceof SpawnError && e.code === "NOT_ADOPTABLE",
    );
  });
});

/**
 * A server shutdown that lands while restart-all is waiting for the old
 * sidecar daemons must win: restart-all stops without respawning, leaves every
 * record "running" (so it resumes on the next boot, not "crashed"), and the
 * daemons it was waiting on are still reaped by the shutdown's sweep.
 *
 * Its own file: the server-stopping flag is one-way per process.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProvider } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-restart-shutdown-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53923);
setAuthToken("test-token-restart-shutdown-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-rd-${randomUUID().slice(0, 8)}.sock`),
);
const { spawnAgent, restartAllAttachments, shutdownAllAttachments } =
  await import("../agents/runtime.js");
const { runningSidecarPids, stopAllSidecars } = await import(
  "../agents/sidecar.js"
);
const { _setProviderForTesting } = await import("../providers/index.js");
const { _resetCodexControlForTesting } = await import(
  "../gateway/codexControl.js"
);
const { codexProvider } = await import("../providers/codex.js");
const { getAgent, _resetCacheForTesting } = await import("../agents/store.js");

const NAME = "fakehung";
const cwd = mkdtempSync(join(tmpdir(), "aos-restart-shutdown-"));
const READY = "listening on ws://stub";

// A daemon that ignores SIGTERM holds restart-all in its wait for the full
// SIGKILL escalation — the window the shutdown lands in.
const fake: AgentProvider = {
  ...codexProvider,
  name: NAME as never,
  displayName: "FakeHung",
  resolveBinary: () => process.execPath,
  buildSidecar: () => ({
    args: [
      "-e",
      `process.on("SIGTERM", () => {}); console.log(${JSON.stringify(READY)}); setInterval(() => {}, 1000);`,
    ],
    readyNeedle: READY,
  }),
  buildArgs: () => ["-e", "setInterval(() => {}, 1000)"],
  hasResumableThread: undefined,
  resumedThreadPermission: undefined,
};
_setProviderForTesting(NAME, fake);

after(() => {
  // The fake daemon is not a real app-server, so the agent's control client
  // retries forever; shutdownAllAttachments can't reach it (restart-all had
  // already emptied `live`), and in a real shutdown the process exit ends it.
  _resetCodexControlForTesting();
  _setProviderForTesting(NAME, null);
  _resetCacheForTesting();
});

describe("restart-all racing a server shutdown", () => {
  it("stops without respawning, keeps the record running, and the daemon is reaped", async () => {
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: NAME as never,
      name: "hung",
    });
    const [daemonPid] = runningSidecarPids();
    assert.ok(daemonPid, "precondition: the agent's daemon is running");

    const restarting = restartAllAttachments();
    await new Promise((r) => setTimeout(r, 200));
    shutdownAllAttachments();

    const result = await restarting;
    assert.deepEqual(result.idMap, {});
    assert.deepEqual(result.failures, []);
    assert.equal(getAgent(agent.id)?.status, "running");
    assert.deepEqual(await stopAllSidecars(), []);
    assert.throws(() => process.kill(daemonPid, 0), { code: "ESRCH" });
  });
});

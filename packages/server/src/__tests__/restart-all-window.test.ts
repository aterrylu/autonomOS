/**
 * restart-all's wait window (it waits for the old agents' processes and
 * daemons to exit before respawning — up to the 2s SIGKILL stage):
 *  - a second restart-all is refused (409), not run against an empty `live`;
 *  - an UNRELATED agent that exits during the wait is still marked exited.
 *    restart-all used to hold the global `shuttingDown` flag across the wait,
 *    which suppressed exit-marking for every agent, not just the ones it was
 *    restarting — an agent that died then stayed "running" with no process.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProvider } from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-restart-window-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53924);
setAuthToken("test-token-restart-window-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-rw-${randomUUID().slice(0, 8)}.sock`),
);
const {
  spawnAgent,
  restartAllAttachments,
  SpawnError,
  shutdownAllAttachments,
} = await import("../agents/runtime.js");
const { awaitPtyExits } = await import("../agents/ptyTerminate.js");
const { stopAllSidecars } = await import("../agents/sidecar.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { _resetCodexControlForTesting } = await import(
  "../gateway/codexControl.js"
);
const { codexProvider } = await import("../providers/codex.js");
const { getAgent, _resetCacheForTesting } = await import("../agents/store.js");

const cwd = mkdtempSync(join(tmpdir(), "aos-restart-window-"));
const READY = "listening on ws://stub";
const base = {
  ...codexProvider,
  resolveBinary: () => process.execPath,
  hasResumableThread: undefined,
  resumedThreadPermission: undefined,
} satisfies Partial<AgentProvider>;

// A daemon that ignores SIGTERM holds restart-all in its wait (~2s).
const hung: AgentProvider = {
  ...base,
  name: "fakehung" as never,
  displayName: "FakeHung",
  buildSidecar: () => ({
    args: [
      "-e",
      `process.on("SIGTERM", () => {}); console.log(${JSON.stringify(READY)}); setInterval(() => {}, 1000);`,
    ],
    readyNeedle: READY,
  }),
  buildArgs: () => ["-e", "setInterval(() => {}, 1000)"],
};
// No daemon; the process exits on its own shortly after starting.
const shortLived: AgentProvider = {
  ...base,
  name: "fakeshort" as never,
  displayName: "FakeShort",
  buildSidecar: undefined,
  buildArgs: () => ["-e", "setTimeout(() => process.exit(0), 300)"],
};
_setProviderForTesting("fakehung", hung);
_setProviderForTesting("fakeshort", shortLived);

after(async () => {
  // Tear down for real — the respawned agent's PTY and daemon would otherwise
  // hold the test runner open.
  _resetCodexControlForTesting();
  shutdownAllAttachments();
  await Promise.all([stopAllSidecars(), awaitPtyExits(5_000)]);
  _setProviderForTesting("fakehung", null);
  _setProviderForTesting("fakeshort", null);
  _resetCacheForTesting();
});

describe("restart-all's wait window", { timeout: 20_000 }, () => {
  it("refuses a second restart-all and still marks an unrelated agent's exit", async () => {
    await spawnAgent({
      workingDirectory: cwd,
      provider: "fakehung" as never,
      name: "hung",
    });
    const restarting = restartAllAttachments();
    await new Promise((r) => setTimeout(r, 100));

    await assert.rejects(
      restartAllAttachments(),
      (err: unknown) =>
        err instanceof SpawnError &&
        err.code === "RESTART_IN_PROGRESS" &&
        err.status === 409,
    );

    // An agent that has nothing to do with the restart, dying mid-wait.
    const { agent: other } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakeshort" as never,
      name: "other",
    });
    // Poll rather than sleep a fixed time: under load the stub's boot + 300ms
    // can take well over a second. With the old global flag the exit is never
    // marked, so this still fails (not just slowly) on a regression.
    const t0 = Date.now();
    while (getAgent(other.id)?.status !== "exited" && Date.now() - t0 < 5_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(
      getAgent(other.id)?.status,
      "exited",
      "an unrelated agent's exit during restart-all was suppressed",
    );

    const result = await restarting;
    assert.deepEqual(result.failures, []);
  });
});

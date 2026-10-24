/**
 * Runtime wiring of the OOM work (agents/oomGuard.ts + runtime.ts): when an
 * agent's process is SIGKILLed from OUTSIDE autonomOS (the kernel OOM killer,
 * systemd-oomd, macOS jetsam), the operator is told which agent and it comes
 * back once in the same record; a second kill inside the window is reported
 * but left down; and the server's own kills never say any of this.
 *
 * Real PTYs, a stand-in agent binary (node). The kernel/systemd side is the
 * CI job scripts/oom-isolation-ci.sh.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentProvider } from "@autonomos/core";

process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-oom-wiring-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53931);
setAuthToken("test-token-oom-wiring-abcdef0123");
setInternalSocketPath(
  join(tmpdir(), `aos-oom-${randomUUID().slice(0, 8)}.sock`),
);

const {
  spawnAgent,
  killAttachment,
  getLiveAgentIds,
  shutdownAllAttachments,
  startOomGuard,
} = await import("../agents/runtime.js");
const { awaitPtyExits } = await import("../agents/ptyTerminate.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { getAgent, _resetCacheForTesting } = await import("../agents/store.js");
const { getNotifications } = await import("../routes/hooks.js");

const cwd = mkdtempSync(join(tmpdir(), "aos-oom-wiring-"));

const { claudeCodeProvider } = await import("../providers/claude-code.js");
const fake: AgentProvider = {
  ...claudeCodeProvider,
  name: "fakeoom" as never,
  displayName: "FakeOOM",
  resolveBinary: () => process.execPath,
  buildArgs: () => ["-e", "setInterval(() => {}, 1000)"],
  // No real ~/.claude lookups: every respawn is a plain start of the record.
  hasResumableSession: undefined,
};
_setProviderForTesting("fakeoom", fake);
startOomGuard();

after(async () => {
  shutdownAllAttachments();
  await awaitPtyExits(5_000);
  _setProviderForTesting("fakeoom", null);
  _resetCacheForTesting();
});

const notices = (id: string) =>
  getNotifications(id)
    .map((n) => JSON.stringify(n))
    .join("\n");

async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("an agent killed from outside autonomOS", { timeout: 60_000 }, () => {
  it("is named in the bell, resumed once in the same record, and left down on a second kill", async () => {
    const name = `oom-${randomUUID().slice(0, 4)}`;
    const { agent, managed } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakeoom" as never,
      name,
    });
    const isLive = () => getLiveAgentIds().includes(agent.id);

    process.kill(managed.pty.pid, "SIGKILL");
    await until(() => !isLive(), 10_000, "the kill to land");
    assert.equal(getAgent(agent.id)?.exitReason, "crashed");
    const first = notices(agent.id);
    assert.match(first, new RegExp(`${name} was killed`));
    assert.match(first, /Resuming it in the same conversation/);

    // Resumed on its own, as the SAME agent record.
    await until(isLive, 15_000, "the automatic resume");
    assert.equal(getAgent(agent.id)?.status, "running");

    const live = (await import("../agents/runtime.js")).getAgentProcessRoots(
      agent.id,
    );
    process.kill(live[0], "SIGKILL");
    await until(() => !isLive(), 10_000, "the second kill to land");
    assert.match(notices(agent.id), /Not resuming it automatically/);
    await new Promise((r) => setTimeout(r, 7_000));
    assert.equal(
      isLive(),
      false,
      "a second kill in the window is not auto-resumed",
    );
  });

  it("the server's own kill is not reported as an outside kill", async () => {
    const name = `own-${randomUUID().slice(0, 4)}`;
    const { agent } = await spawnAgent({
      workingDirectory: cwd,
      provider: "fakeoom" as never,
      name,
    });
    killAttachment(agent.id);
    await awaitPtyExits(5_000);
    assert.doesNotMatch(notices(agent.id), /was killed/);
  });
});

/**
 * Runtime wiring of the OOM work (agents/oomGuard.ts + runtime.ts, ADR-155):
 *  - an agent SIGKILLed from OUTSIDE autonomOS (the OOM killer, systemd-oomd,
 *    macOS jetsam) is named in the bell and resumed once, in the same record;
 *    a second kill inside the window is reported and left down;
 *  - the operator's own Kill or Resume during the resume wait wins (never two
 *    processes on one conversation);
 *  - the server's OWN kills (stop, restart — with SIGKILL escalation) are
 *    never reported as outside kills;
 *  - on Linux, every spawned agent really gets the raised OOM score.
 *
 * Real PTYs, a stand-in agent binary (node). The kernel/systemd side is the
 * CI step scripts/oom-isolation-ci.sh.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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
  restartAgent,
  getLiveAgentIds,
  getAgentProcessRoots,
  shutdownAllAttachments,
  startOomGuard,
  _setOomResumeDelayForTesting,
} = await import("../agents/runtime.js");
const { awaitPtyExits } = await import("../agents/ptyTerminate.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { getAgent, _resetCacheForTesting } = await import("../agents/store.js");
const { getNotifications } = await import("../routes/hooks.js");
const { claudeCodeProvider } = await import("../providers/claude-code.js");
const { AGENT_OOM_SCORE_RAISE } = await import("../agents/oomGuard.js");

const cwd = mkdtempSync(join(tmpdir(), "aos-oom-wiring-"));

/** When set, the stand-in ignores SIGHUP/SIGTERM, so the server's own stop
 *  has to escalate to SIGKILL, the same signal an outside kill uses. */
let stubborn = false;
const fake: AgentProvider = {
  ...claudeCodeProvider,
  name: "fakeoom" as never,
  displayName: "FakeOOM",
  resolveBinary: () => process.execPath,
  buildArgs: () => [
    "-e",
    stubborn
      ? "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
      : "setInterval(()=>{},1000)",
  ],
  // No real ~/.claude lookups: every respawn is a plain start of the record.
  hasResumableSession: undefined,
};
_setProviderForTesting("fakeoom", fake);
startOomGuard();
_setOomResumeDelayForTesting(300);

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newAgent(prefix: string) {
  const name = `${prefix}-${randomUUID().slice(0, 4)}`;
  const { agent } = await spawnAgent({
    workingDirectory: cwd,
    provider: "fakeoom" as never,
    name,
  });
  const isLive = () => getLiveAgentIds().includes(agent.id);
  const leader = () => getAgentProcessRoots(agent.id)[0];
  return { agent, name, isLive, leader };
}

describe("an agent killed from outside autonomOS", { timeout: 90_000 }, () => {
  it("is named in the bell, resumed once in the same record, and left down on a second kill", async () => {
    const { agent, name, isLive, leader } = await newAgent("oom");

    process.kill(leader(), "SIGKILL");
    await until(() => !isLive(), 10_000, "the kill to land");
    assert.equal(getAgent(agent.id)?.exitReason, "crashed");
    assert.match(notices(agent.id), new RegExp(`${name} was killed`));
    assert.match(notices(agent.id), /Resuming it in the same conversation/);

    await until(isLive, 15_000, "the automatic resume");
    assert.equal(getAgent(agent.id)?.status, "running");

    process.kill(leader(), "SIGKILL");
    await until(() => !isLive(), 10_000, "the second kill to land");
    assert.match(notices(agent.id), /Not resuming it automatically/);
    await sleep(1_500);
    assert.equal(
      isLive(),
      false,
      "a second kill in the window is not auto-resumed",
    );
  });

  it("the operator's Kill during the resume wait wins", async () => {
    const { agent, isLive, leader } = await newAgent("killwins");
    process.kill(leader(), "SIGKILL");
    await until(() => !isLive(), 10_000, "the kill to land");
    killAttachment(agent.id); // within the 300 ms wait
    await sleep(1_500);
    assert.equal(isLive(), false, "the pending resume was cancelled");
  });

  it("the operator's Resume during the wait doesn't double-spawn", async () => {
    const { agent, isLive, leader } = await newAgent("resumewins");
    process.kill(leader(), "SIGKILL");
    await until(() => !isLive(), 10_000, "the kill to land");
    await spawnAgent({
      workingDirectory: cwd,
      provider: "fakeoom" as never,
      resumeAgentId: agent.id,
    });
    const pid = leader();
    await sleep(1_500);
    assert.equal(
      leader(),
      pid,
      "the same process: no second spawn replaced it",
    );
    assert.equal(isLive(), true);
  });
});

describe("the server's own kills", { timeout: 90_000 }, () => {
  it("a stop that escalates to SIGKILL is not reported as an outside kill, and not resumed", async () => {
    stubborn = true;
    try {
      const { agent, isLive } = await newAgent("ownkill");
      killAttachment(agent.id);
      await awaitPtyExits(15_000);
      await sleep(1_000);
      assert.doesNotMatch(notices(agent.id), /was killed/);
      assert.equal(isLive(), false);
      assert.equal(getAgent(agent.id)?.exitReason, "user_killed");
    } finally {
      stubborn = false;
    }
  });

  it("a restart (SIGTERM → SIGKILL) is not reported as an outside kill", async () => {
    stubborn = true;
    try {
      const { agent, isLive } = await newAgent("ownrestart");
      await restartAgent(agent.id);
      await sleep(1_000);
      assert.doesNotMatch(notices(agent.id), /was killed/);
      assert.equal(isLive(), true);
    } finally {
      stubborn = false;
    }
  });
});

describe("on Linux, a spawned agent really gets the raised OOM score", {
  skip: process.platform !== "linux",
}, () => {
  it("its process's oom_score_adj is the server's + 500 (capped at 1000)", async () => {
    const { leader } = await newAgent("score");
    const base = Number(readFileSync("/proc/self/oom_score_adj", "utf-8"));
    const got = Number(
      readFileSync(`/proc/${leader()}/oom_score_adj`, "utf-8"),
    );
    assert.equal(got, Math.min(1000, base + AGENT_OOM_SCORE_RAISE));
  });
});

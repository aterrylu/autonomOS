/**
 * END-TO-END through the real spawnAgent reattach path (ADR-104), with a fake
 * Codex-like runtime (a real PTY running `/bin/sh -c sleep`, no daemon). The
 * pure-helper tests pin each decision; this pins what spawnAgent actually DOES
 * with them to the persisted record and the argv — the (G) write-back is exactly
 * where a regression would silently clear real threads.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type {
  AgentProvider,
  PermissionMode,
  ResolvedSpawnOptions,
  UUID,
} from "@autonomos/core";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-codex-resume-spawn-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53921);
setAuthToken("test-token-resume-spawn-abcdef");
// The spawn path requires the control plane to look bound (ADR-055); nothing
// connects to it here — the fake runtime is `sh -c sleep`.
setInternalSocketPath(
  join(tmpdir(), `aos-rs-${randomUUID().slice(0, 8)}.sock`),
);
const { spawnAgent, killAttachment } = await import("../agents/runtime.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { codexProvider } = await import("../providers/codex.js");
const {
  buildAgent,
  insertAgent,
  patchAgent,
  getAgent,
  markExited,
  _resetCacheForTesting,
} = await import("../agents/store.js");
const { getNotifications, clearNotifications } = await import(
  "../routes/hooks.js"
);

const NAME = "fakecodex";
const cwd = mkdtempSync(join(tmpdir(), "aos-resume-spawn-"));
let seen: ResolvedSpawnOptions[] = [];
let threadSaved: boolean | "throw" = true;
let actualMode: PermissionMode | undefined;

const fake: AgentProvider = {
  ...codexProvider,
  name: NAME as never,
  displayName: "FakeCodex",
  resolveBinary: () => "/bin/sh",
  buildSidecar: undefined,
  buildArgs: (r: ResolvedSpawnOptions) => {
    seen.push({ ...r });
    return ["-c", "sleep 30"];
  },
  hasResumableThread: () => {
    if (threadSaved === "throw") throw new Error("EACCES");
    return threadSaved;
  },
  resumedThreadMode: () => actualMode,
};

const ids: string[] = [];
function seed(mode: PermissionMode, thread = "thread-real-123"): UUID {
  const id = randomUUID() as UUID;
  ids.push(id);
  insertAgent(
    buildAgent({
      id,
      name: `fc-${id.slice(0, 4)}`,
      workingDirectory: cwd,
      provider: NAME as never,
      providerSessionId: id,
      permissionMode: mode,
      status: "running",
    }),
  );
  patchAgent(id, { providerThreadId: thread });
  markExited(id, "user_killed");
  return id;
}

beforeEach(() => {
  _setProviderForTesting(NAME, fake);
  seen = [];
  threadSaved = true;
  actualMode = undefined;
});
afterEach(() => {
  for (const id of ids.splice(0)) {
    killAttachment(id as UUID);
    clearNotifications(id);
  }
});
after(() => {
  _setProviderForTesting(NAME, null);
  _resetCacheForTesting();
});
const notices = (id: string) =>
  getNotifications(id).map((n) => n.message ?? "");

describe("spawnAgent reattach — Codex resume (ADR-104)", () => {
  it("a SAVED thread is resumed and KEPT on the record (no silent clear)", async () => {
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(seen.at(-1)?.providerThreadId, "thread-real-123");
    assert.equal(getAgent(id)?.providerThreadId, "thread-real-123");
  });

  it("a never-saved thread starts fresh: argv has no thread, record cleared, notice names the old id", async () => {
    threadSaved = false;
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(seen.at(-1)?.providerThreadId, undefined);
    assert.equal(getAgent(id)?.providerThreadId, undefined);
    assert.ok(notices(id).some((m) => m.includes("thread-real-123")));
  });

  it("a probe that CAN'T TELL fails open: thread kept, resumed", async () => {
    threadSaved = "throw";
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(seen.at(-1)?.providerThreadId, "thread-real-123");
    assert.equal(getAgent(id)?.providerThreadId, "thread-real-123");
  });

  it("a mode change that can't apply is REFUSED: argv + record keep the running mode, user told", async () => {
    const id = seed("ask");
    await spawnAgent({
      workingDirectory: cwd,
      resumeAgentId: id,
      permissionMode: "bypass",
    });
    assert.equal(seen.at(-1)?.permissionMode, "ask");
    assert.equal(getAgent(id)?.permissionMode, "ask");
    assert.ok(notices(id).some((m) => m.includes("was not applied")));
  });

  it("a record that lies about the thread's real mode is CORRECTED (silently wider was the bug)", async () => {
    actualMode = "bypass";
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(getAgent(id)?.permissionMode, "bypass");
    assert.ok(notices(id).some((m) => m.includes("actually runs as bypass")));
  });

  it("an omitted provider resumes as the RECORD's runtime, never claude-code", async () => {
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(getAgent(id)?.provider, NAME);
  });
});

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
import {
  type AgentProvider,
  completePermission,
  type PermissionMode,
  type ResolvedSpawnOptions,
  type RuntimePermission,
  type UUID,
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
const { updateSettings } = await import("../settings.js");

// Registered AS "codex" (restored in after()): the permission layer is keyed by
// the runtime, so the fake must speak Codex's vocabulary to exercise its lock.
const NAME = "codex";
const cwd = mkdtempSync(join(tmpdir(), "aos-resume-spawn-"));
let seen: ResolvedSpawnOptions[] = [];
let threadSaved: boolean | "throw" = true;
let actualPermission: RuntimePermission | undefined;

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
  resumedThreadPermission: () => actualPermission,
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
  actualPermission = undefined;
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

  it("a change that can't apply is REFUSED: argv + record keep the running setting, user told", async () => {
    const id = seed("ask");
    await spawnAgent({
      workingDirectory: cwd,
      resumeAgentId: id,
      permission: completePermission("codex", { approval_policy: "never" }),
    });
    assert.equal(seen.at(-1)?.permission?.values.approval_policy, "on-request");
    assert.equal(
      getAgent(id)?.permission?.values.approval_policy,
      "on-request",
    );
    assert.equal(getAgent(id)?.permissionMode, "ask");
    assert.ok(notices(id).some((m) => m.includes("was not applied")));
  });

  it("the same refusal for a LEGACY caller (permissionMode: bypass)", async () => {
    const id = seed("ask");
    await spawnAgent({
      workingDirectory: cwd,
      resumeAgentId: id,
      permissionMode: "bypass",
    });
    assert.equal(seen.at(-1)?.permission?.values.approval_policy, "on-request");
    assert.equal(getAgent(id)?.permissionMode, "ask");
  });

  it("a record that lies about the thread's real setting is CORRECTED (silently wider was the bug)", async () => {
    actualPermission = completePermission("codex", {
      approval_policy: "never",
    });
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(getAgent(id)?.permission?.values.approval_policy, "never");
    assert.equal(getAgent(id)?.permissionMode, "bypass");
    assert.ok(
      notices(id).some((m) =>
        m.includes("actually runs approval_policy=never"),
      ),
    );
  });

  it("a migrated Codex auto record gets the one-time notice, then never again", async () => {
    const id = seed("ask");
    patchAgent(id, { permissionMigratedFrom: "auto" });
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.ok(notices(id).some((m) => m.includes('"auto" was never')));
    assert.equal(getAgent(id)?.permissionMigratedFrom, undefined);
    killAttachment(id as UUID);
    markExited(id, "user_killed");
    clearNotifications(id);
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.ok(!notices(id).some((m) => m.includes("was never")));
  });

  it("a fresh spawn with legacy plan is told what it runs, in Codex's own values", async () => {
    const agent = (
      await spawnAgent({
        workingDirectory: cwd,
        provider: NAME,
        name: `fc-plan-${randomUUID().slice(0, 4)}`,
        permissionMode: "plan",
      })
    ).agent;
    ids.push(agent.id);
    assert.equal(
      getAgent(agent.id)?.permission?.values.approval_policy,
      "on-request",
    );
    assert.ok(
      notices(agent.id).some((m) =>
        m.includes(
          '"plan" isn\'t a FakeCodex setting, so it runs approval_policy=on-request · sandbox_mode=danger-full-access',
        ),
      ),
      JSON.stringify(notices(agent.id)),
    );
  });

  it("a fresh spawn that names nothing gets the OPERATOR's default; a resume ignores a later change to it", async () => {
    updateSettings({
      runtimeDefaults: { codex: { approval_policy: "never" } },
    });
    try {
      const { agent } = await spawnAgent({
        workingDirectory: cwd,
        provider: NAME,
        name: `fc-def-${randomUUID().slice(0, 4)}`,
      });
      ids.push(agent.id);
      assert.equal(seen.at(-1)?.permission?.values.approval_policy, "never");
      assert.equal(getAgent(agent.id)?.permissionMode, "bypass");
      // The operator changes the default; a body-less resume keeps the record.
      updateSettings({ runtimeDefaults: undefined });
      killAttachment(agent.id);
      markExited(agent.id, "user_killed");
      await spawnAgent({ workingDirectory: cwd, resumeAgentId: agent.id });
      assert.equal(seen.at(-1)?.permission?.values.approval_policy, "never");
    } finally {
      updateSettings({ runtimeDefaults: undefined });
    }
  });

  it("an explicit request beats the operator's default", async () => {
    updateSettings({
      runtimeDefaults: { codex: { approval_policy: "never" } },
    });
    try {
      const { agent } = await spawnAgent({
        workingDirectory: cwd,
        provider: NAME,
        name: `fc-exp-${randomUUID().slice(0, 4)}`,
        permissionMode: "ask",
      });
      ids.push(agent.id);
      assert.equal(
        getAgent(agent.id)?.permission?.values.approval_policy,
        "on-request",
      );
    } finally {
      updateSettings({ runtimeDefaults: undefined });
    }
  });

  it("an omitted provider resumes as the RECORD's runtime, never claude-code", async () => {
    const id = seed("ask");
    await spawnAgent({ workingDirectory: cwd, resumeAgentId: id });
    assert.equal(getAgent(id)?.provider, NAME);
  });
});

/**
 * Restart with a new permission (the Permission… action): the agent respawns
 * in the SAME conversation with the chosen canonical value, the record updates,
 * and nothing widens silently.
 *  - Claude Code: the session id is kept; the new value reaches argv + record.
 *  - A widening to a never-asks value is refused (400) BEFORE anything stops.
 *  - Codex: a resumed thread keeps its policy (ADR-104), so a change is refused
 *    up front (409) unless a fresh conversation is asked for explicitly; with
 *    it, the thread is dropped and the new permission applies.
 * Fake runtimes registered under the REAL runtime names (permissions are
 * parsed per runtime); real PTYs running idle node — no CLI, no login.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  type AgentProvider,
  completePermission,
  type ResolvedSpawnOptions,
  type UUID,
} from "@autonomos/core";
import { Hono } from "hono";

// UNCONDITIONAL: workers inherit AUTONOMOS_CONFIG_DIR=<real dir> (#350).
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-restart-perm-${randomUUID()}`;

const { setServerPort, setAuthToken, setInternalSocketPath } = await import(
  "../serverState.js"
);
setServerPort(53951);
setAuthToken("test-token-restart-permission-abcdef");
setInternalSocketPath(
  join(tmpdir(), `aos-rp-${randomUUID().slice(0, 8)}.sock`),
);
const { killAttachment } = await import("../agents/runtime.js");
const { agentsRouter } = await import("../routes/agents.js");
const { _setProviderForTesting } = await import("../providers/index.js");
const { claudeCodeProvider } = await import("../providers/claude-code.js");
const { codexProvider } = await import("../providers/codex.js");
const { buildAgent, insertAgent, getAgent, markExited, patchAgent } =
  await import("../agents/store.js");
const { getNotifications } = await import("../routes/hooks.js");

const cwd = mkdtempSync(join(tmpdir(), "aos-rp-cwd-"));
const IDLE = ["-e", "setInterval(() => {}, 1000)"];

/** What each fake was last asked to spawn. */
const seen: Record<string, ResolvedSpawnOptions | undefined> = {};

const fakeClaude: AgentProvider = {
  ...claudeCodeProvider,
  resolveBinary: () => process.execPath,
  hasResumableSession: () => true, // keep the session id: the conversation exists
  buildArgs: (r: ResolvedSpawnOptions) => {
    seen["claude-code"] = { ...r };
    return IDLE;
  },
};
const fakeCodex: AgentProvider = {
  ...codexProvider,
  resolveBinary: () => process.execPath,
  buildSidecar: undefined, // no daemon: this tests the record + guards
  hasResumableThread: () => true,
  resumedThreadPermission: () => undefined,
  buildArgs: (r: ResolvedSpawnOptions) => {
    seen.codex = { ...r };
    return IDLE;
  },
};
_setProviderForTesting("claude-code", fakeClaude);
_setProviderForTesting("codex", fakeCodex);

const app = new Hono();
app.route("/api/agents", agentsRouter);

const ids: UUID[] = [];
/** A stopped agent with a conversation, as a restart finds it. */
function seed(
  provider: "claude-code" | "codex",
  values: Record<string, string>,
  thread?: string,
): UUID {
  const id = randomUUID() as UUID;
  ids.push(id);
  insertAgent(
    buildAgent({
      id,
      name: `rp-${id.slice(0, 4)}`,
      workingDirectory: cwd,
      provider: provider as never,
      providerSessionId: id,
      permissionMode: "ask",
      permission: completePermission(provider, values),
      status: "running",
    } as never),
  );
  if (thread) patchAgent(id, { providerThreadId: thread });
  markExited(id, "user_killed");
  return id;
}

const restart = (id: UUID, body?: unknown) =>
  app.request(`/api/agents/${id}/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

afterEach(() => {
  for (const id of ids.splice(0)) killAttachment(id);
});
after(() => {
  _setProviderForTesting("claude-code", null);
  _setProviderForTesting("codex", null);
});

describe("restart with a new permission", { timeout: 120_000 }, () => {
  it("Claude Code: same conversation (session id kept), new value in argv AND the record", async () => {
    const id = seed("claude-code", { "permission-mode": "manual" });
    const res = await restart(id, { permission: "auto" });
    assert.equal(res.status, 200, await res.clone().text());
    const rec = getAgent(id);
    assert.equal(rec?.providerSessionId, id, "the conversation is kept");
    assert.equal(rec?.permission?.values["permission-mode"], "auto");
    assert.equal(
      seen["claude-code"]?.permission?.values["permission-mode"],
      "auto",
    );
  });

  it("a widening to a value that NEVER asks is refused before anything stops; the confirm lets it through", async () => {
    const id = seed("claude-code", { "permission-mode": "auto" });
    const res = await restart(id, { permission: "bypassPermissions" });
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "CONFIRM_NEVER_ASKS",
    );
    assert.equal(
      getAgent(id)?.permission?.values["permission-mode"],
      "auto",
      "nothing changed",
    );
    const ok = await restart(id, {
      permission: "bypassPermissions",
      confirmNeverAsks: true,
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(
      getAgent(id)?.permission?.values["permission-mode"],
      "bypassPermissions",
    );
  });

  it("narrowing (bypass → auto) needs no confirm", async () => {
    const id = seed("claude-code", { "permission-mode": "bypassPermissions" });
    const res = await restart(id, { permission: "auto" });
    assert.equal(res.status, 200, await res.clone().text());
  });

  it("an invalid value is a 400 naming the valid ones", async () => {
    const id = seed("claude-code", { "permission-mode": "manual" });
    const res = await restart(id, { permission: "turbo" });
    assert.equal(res.status, 400);
    assert.match(
      ((await res.json()) as { error: string }).error,
      /acceptEdits/,
    );
  });

  it("Codex: a change to a resumed thread is refused UP FRONT (409) — nothing restarts", async () => {
    const id = seed("codex", {}, "thread-old");
    const res = await restart(id, { permission: "sandbox_mode=read-only" });
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "PERMISSION_NEEDS_FRESH_CONVERSATION",
    );
    const rec = getAgent(id);
    assert.equal(rec?.status, "exited", "not respawned");
    assert.equal(rec?.providerThreadId, "thread-old");
    assert.equal(rec?.permission?.values.sandbox_mode, "danger-full-access");
  });

  it("Codex + freshConversation: the old thread is dropped and the new permission applies, said in a notice", async () => {
    const id = seed("codex", {}, "thread-old");
    const res = await restart(id, {
      permission: "sandbox_mode=read-only",
      freshConversation: true,
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(seen.codex?.providerThreadId, undefined, "a NEW conversation");
    const rec = getAgent(id);
    assert.equal(rec?.permission?.values.sandbox_mode, "read-only");
    assert.ok(
      getNotifications(id).some((n) =>
        (n.message ?? "").includes(
          "conversation, as asked, so its new permission applies",
        ),
      ),
    );
  });

  it("valid JSON that isn't an object (null, an array, a number) is a 400, not a crash", async () => {
    const id = seed("claude-code", { "permission-mode": "manual" });
    for (const body of [null, ["auto"], 3]) {
      const res = await restart(id, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.status}`);
    }
    assert.equal(getAgent(id)?.status, "exited", "nothing restarted");
  });

  it("no body: a plain restart respawns exactly as recorded", async () => {
    const id = seed("claude-code", { "permission-mode": "acceptEdits" });
    const res = await restart(id);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(
      getAgent(id)?.permission?.values["permission-mode"],
      "acceptEdits",
    );
  });
});

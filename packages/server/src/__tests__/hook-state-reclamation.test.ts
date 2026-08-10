/**
 * DELETE reclaims the in-memory hook state with the record. Before this,
 * `clearAgentState`/`clearNotifications` had NO production caller: deleting an
 * agent left its status entry and notifications in the maps forever, so
 * `GET /api/agent-status` (né /api/hooks) kept returning ids no store lookup could resolve.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { UUID } from "@autonomos/core";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

const { deleteAgent } = await import("../agents/runtime.js");
const {
  hooksIngestRouter,
  hooksReadRouter,
  pushSystemNotification,
  setAgentStatus,
} = await import("../routes/hooks.js");
const { mintAgentToken } = await import("../agentCredentials.js");

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001" as UUID;
let isolatedDir: string;

// File-level fixture: every test here starts from an isolated config dir
// holding exactly one agent, and tears the directory down after.
beforeEach(() => {
  isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-reclaim-"));
  _setConfigDirForTesting(isolatedDir);
  _resetCacheForTesting();
  insertAgent(
    buildAgent({
      id: AGENT_ID,
      name: "Doomed",
      workingDirectory: "/tmp",
      provider: "claude-code",
      providerSessionId: AGENT_ID,
      permissionMode: "ask",
    }),
  );
});

afterEach(() => {
  _resetConfigDirForTesting();
  _resetCacheForTesting();
  rmSync(isolatedDir, { recursive: true, force: true });
});

/** Ids carrying a status entry on the bulk status map. */
async function statusIds(): Promise<string[]> {
  const res = await hooksReadRouter.request("/", { method: "GET" });
  return Object.keys((await res.json()) as Record<string, unknown>);
}

/** Ids appearing in the notification feed. */
async function notifiedIds(): Promise<string[]> {
  const res = await hooksReadRouter.request("/notifications", {
    method: "GET",
  });
  const body = (await res.json()) as {
    notifications: Array<{ sessionId: string }>;
  };
  return body.notifications.map((n) => n.sessionId);
}

describe("hook-state reclamation on agent delete", () => {
  it("deleteAgent removes the status entry and notifications from the read surface", async () => {
    setAgentStatus(AGENT_ID, "working");
    pushSystemNotification(AGENT_ID, "orphan-to-be");

    // Both visible on the bulk read surfaces before the delete.
    assert.ok((await statusIds()).includes(AGENT_ID), "status entry present");
    assert.ok((await notifiedIds()).includes(AGENT_ID), "notification present");

    assert.equal(deleteAgent(AGENT_ID), true);

    // Gone from BOTH — no unresolvable ids left behind.
    assert.equal(
      (await statusIds()).includes(AGENT_ID),
      false,
      "status entry reclaimed",
    );
    assert.equal(
      (await notifiedIds()).includes(AGENT_ID),
      false,
      "notifications reclaimed",
    );
  });
});

describe("delete revokes the agent token — stragglers cannot resurrect state", () => {
  it("a post-delete hook curl is rejected and the bulk read stays clean", async () => {
    // The dying process fires its final hook curls AFTER deleteAgent ran:
    // markExited's not-found early-return means its revoke never fires on this
    // path, so without the delete-path revoke the straggler passes token
    // verification, deriveStatus(SessionEnd) → "stopped", and the status map
    // re-grows an entry no store lookup can resolve — the exact leak the
    // reclamation exists to close, reintroduced on the most common path.
    const token = mintAgentToken(AGENT_ID);
    // Assert the precondition rather than just setting it: the token must be
    // ACCEPTED while the agent lives, or the 401 below could have any cause.
    const liveIngest = await hooksIngestRouter.request(`/${AGENT_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": token,
      },
      body: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
    });
    assert.equal(liveIngest.status, 200, "token must verify pre-delete");
    setAgentStatus(AGENT_ID, "working");
    assert.equal(deleteAgent(AGENT_ID), true);
    assert.deepEqual(await statusIds(), []);

    const straggler = await hooksIngestRouter.request(`/${AGENT_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": token,
      },
      body: JSON.stringify({ hook_event_name: "SessionEnd" }),
    });
    assert.equal(straggler.status, 401, "revoked token must be rejected");
    assert.deepEqual(
      await statusIds(),
      [],
      "the straggler must not resurrect the status entry",
    );
  });
});

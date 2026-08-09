import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";

/**
 * DELETE reclaims the in-memory hook state with the record (API-consolidation
 * dead-surface pass). Before this, `clearAgentState`/`clearNotifications` had
 * NO production caller: deleting an agent left its status entry and
 * notifications in the maps forever, so `GET /api/hooks` kept returning ids
 * that no store lookup could resolve.
 */

const { deleteAgent } = await import("../agents/runtime.js");
const { hooksReadRouter, pushSystemNotification, setAgentStatus } =
  await import("../routes/hooks.js");

const AGENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001";
let isolatedDir: string;

describe("hook-state reclamation on agent delete", () => {
  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-reclaim-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
    insertAgent(
      buildAgent({
        id: AGENT_ID as never,
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

  it("deleteAgent removes the status entry and notifications from the read surface", async () => {
    setAgentStatus(AGENT_ID, "working");
    pushSystemNotification(AGENT_ID, "orphan-to-be");

    // Both visible on the bulk read surface before the delete.
    let bulk = (await (
      await hooksReadRouter.request("/", { method: "GET" })
    ).json()) as Record<string, unknown>;
    assert.ok(AGENT_ID in bulk, "status entry present before delete");
    let feed = (await (
      await hooksReadRouter.request("/notifications", { method: "GET" })
    ).json()) as { notifications: Array<{ sessionId: string }> };
    assert.ok(
      feed.notifications.some((n) => n.sessionId === AGENT_ID),
      "notification present before delete",
    );

    assert.equal(deleteAgent(AGENT_ID as never), true);

    // Gone from BOTH read surfaces — no unresolvable ids left behind.
    bulk = (await (
      await hooksReadRouter.request("/", { method: "GET" })
    ).json()) as Record<string, unknown>;
    assert.equal(AGENT_ID in bulk, false, "status entry reclaimed");
    feed = (await (
      await hooksReadRouter.request("/notifications", { method: "GET" })
    ).json()) as { notifications: Array<{ sessionId: string }> };
    assert.equal(
      feed.notifications.some((n) => n.sessionId === AGENT_ID),
      false,
      "notifications reclaimed",
    );
  });
});

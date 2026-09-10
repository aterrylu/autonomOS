/**
 * F3 — the sidebar unread (#num) badge and the bell panel must agree. Before the
 * fix they read different sets: the sidebar counted ALL unread events while the
 * panel filtered to SendUserMessage/SystemWarning, so a Stop/Notification/
 * PermissionRequest unread showed "N" on the row and "No notifications" in the
 * panel. Now ONE predicate (isUserFacingNotification) gates both: a raw turn-end
 * Stop is withheld from both (it's activity), while Notification / PermissionRequest
 * / SendUserMessage are counted AND shown on both.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NotificationFeed } from "@autonomos/core";

process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-unread-consistency-${randomUUID()}`;

const { buildAgent, insertAgent, _resetCacheForTesting } = await import(
  "../agents/store.js"
);
const { mintAgentToken } = await import("../agentCredentials.js");
const {
  hooksIngestRouter,
  notificationsRouter,
  getUnreadCount,
  isUserFacingNotification,
  clearNotifications,
  clearAgentState,
} = await import("../routes/hooks.js");

const ids: string[] = [];
function seedCC(): string {
  const id = randomUUID();
  ids.push(id);
  insertAgent(
    buildAgent({
      id: id as never,
      name: "CC",
      workingDirectory: "/tmp",
      provider: "claude-code",
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  return id;
}

async function postHook(sid: string, body: Record<string, unknown>) {
  return hooksIngestRouter.request(`/${sid}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Token": mintAgentToken(sid),
    },
    body: JSON.stringify(body),
  });
}

/** The bell panel's view: its own totalUnread + the events it renders. */
async function panel(): Promise<NotificationFeed> {
  const res = await notificationsRouter.request("/", { method: "GET" });
  return (await res.json()) as NotificationFeed;
}

beforeEach(() => _resetCacheForTesting());
afterEach(() => {
  for (const id of ids.splice(0)) {
    clearNotifications(id);
    clearAgentState(id);
  }
  _resetCacheForTesting();
});

describe("unread consistency (F3) — sidebar badge == bell panel", () => {
  it("the predicate withholds only raw Stop; everything else is user-facing", () => {
    const at = Date.now();
    const facing = (event: string) =>
      isUserFacingNotification({ event, timestamp: at, read: false });
    assert.equal(
      facing("Stop"),
      false,
      "raw turn-end is activity, not a notification",
    );
    for (const e of [
      "SendUserMessage",
      "SystemWarning",
      "PermissionRequest",
      "Notification",
      "AgentMessage",
    ]) {
      assert.equal(facing(e), true, `${e} must be user-facing`);
    }
  });

  it("a Stop hook neither counts nor shows (no phantom badge)", async () => {
    const id = seedCC();
    assert.equal((await postHook(id, { hook_event_name: "Stop" })).status, 200);
    assert.equal(getUnreadCount(id), 0, "sidebar: Stop is not counted");
    const p = await panel();
    assert.equal(p.totalUnread, 0, "panel: Stop is not shown");
    assert.equal(
      p.notifications.some((n) => n.sessionId === id),
      false,
      "no Stop entry in the panel",
    );
  });

  it("Notification + PermissionRequest + SendUserMessage all count AND show — sidebar == panel", async () => {
    const id = seedCC();
    await postHook(id, {
      hook_event_name: "Notification",
      message: "heads up",
    });
    await postHook(id, { hook_event_name: "PermissionRequest" });
    await postHook(id, {
      hook_event_name: "PreToolUse",
      tool_name: "SendUserMessage",
      tool_input: { message: "done" },
    });
    // A Stop mixed in must NOT change the count.
    await postHook(id, { hook_event_name: "Stop" });

    const sidebar = getUnreadCount(id);
    assert.equal(sidebar, 3, "3 user-facing events counted, Stop excluded");

    const p = await panel();
    const forThis = p.notifications.filter((n) => n.sessionId === id);
    assert.equal(
      p.totalUnread,
      sidebar,
      "panel totalUnread must equal the sidebar badge (F3)",
    );
    const events = forThis.map((n) => n.event).sort();
    assert.deepEqual(events, [
      "Notification",
      "PermissionRequest",
      "SendUserMessage",
    ]);
    assert.ok(
      !events.includes("Stop"),
      "the de-phantomed panel still excludes raw Stop",
    );
  });
});

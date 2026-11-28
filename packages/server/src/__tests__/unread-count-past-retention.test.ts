/**
 * The unread count is TRUE past the notification retention cap. Each session
 * keeps only its NOTIFICATION_RETENTION (50) most recent notifications, and the
 * count used to be derived from that capped list, so a busy agent's badge
 * stopped at 50 however many messages it had sent. Retention is a memory bound;
 * the count is "unread since the last markRead", whatever is still retained.
 *
 * Covers every path that feeds the count: Claude Code and Gemini hooks,
 * Codex turn replies (noteAgentMessage), server SystemWarnings, plus the bell
 * feed, the live delta and the bulk snapshot.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDelta, NotificationFeed } from "@autonomos/core";

// UNCONDITIONAL (not ??=): worker agents inherit AUTONOMOS_CONFIG_DIR=<real dir>.
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-unread-retention-${randomUUID()}`;

const { buildAgent, insertAgent, _resetCacheForTesting } = await import(
  "../agents/store.js"
);
const { mintAgentToken } = await import("../agentCredentials.js");
const { onAgentDelta } = await import("../events/agents.js");
const {
  hooksIngestRouter,
  notificationsRouter,
  getUnreadCount,
  getNotifications,
  getAgentStatusSnapshot,
  markRead,
  clearNotifications,
  clearAgentState,
  noteAgentMessage,
  pushSystemNotification,
  retractSystemNotification,
  setAgentStatus,
  NOTIFICATION_RETENTION,
} = await import("../routes/hooks.js");

const ids: string[] = [];
function seed(provider: "claude-code" | "gemini-cli" | "codex"): string {
  const id = randomUUID();
  ids.push(id);
  insertAgent(
    buildAgent({
      id: id as never,
      name: provider,
      workingDirectory: "/tmp",
      provider,
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  return id;
}

async function postHook(sid: string, body: Record<string, unknown>) {
  const res = await hooksIngestRouter.request(`/${sid}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Token": mintAgentToken(sid),
    },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
}

async function notify(sid: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await postHook(sid, { hook_event_name: "Notification", message: `m${i}` });
  }
}

async function feed(): Promise<NotificationFeed> {
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

describe("unread count past the retention cap", () => {
  it("precondition: the cap this suite pushes past is 50", () => {
    assert.equal(NOTIFICATION_RETENTION, 50);
  });

  it("Claude Code: 75 unread count as 75 while only 50 are retained", async () => {
    const id = seed("claude-code");
    await notify(id, 75);
    assert.equal(getNotifications(id).length, 50, "retention still bounded");
    assert.equal(
      getUnreadCount(id),
      75,
      "the count is not the retained length",
    );
  });

  it("Gemini (same hook relay): 75 unread count as 75", async () => {
    const id = seed("gemini-cli");
    await notify(id, 75);
    assert.equal(getUnreadCount(id), 75);
  });

  it("Codex turn replies: 75 unread count as 75", () => {
    const id = seed("codex");
    setAgentStatus(id, "working");
    for (let i = 0; i < 75; i++) noteAgentMessage(id, `reply ${i}`);
    assert.equal(getNotifications(id).length, 50);
    assert.equal(getUnreadCount(id), 75);
  });

  it("the live delta, the snapshot and the bell feed all carry the true count", async () => {
    const id = seed("claude-code");
    setAgentStatus(id, "working"); // unread deltas need a state entry
    let lastUnread = -1;
    const unsubscribe = onAgentDelta((d: AgentDelta) => {
      if (d.type === "agent.status" && d.id === id) lastUnread = d.unread;
    });
    try {
      await notify(id, 75);
    } finally {
      unsubscribe();
    }
    assert.equal(lastUnread, 75, "the pushed badge count");
    assert.equal(
      getAgentStatusSnapshot()[id]?.unread,
      75,
      "reconcile snapshot",
    );
    const f = await feed();
    assert.equal(f.totalUnread, 75, "bell total == sidebar badge");
    assert.equal(
      f.notifications.filter((n) => n.sessionId === id).length,
      50,
      "the feed lists only what is retained",
    );
    assert.equal(f.unreadNotShown, 25, "and says how many it can't show");
  });

  it("markRead zeroes the evicted part too, and it never comes back", async () => {
    const id = seed("claude-code");
    await notify(id, 75);
    markRead(id);
    assert.equal(getUnreadCount(id), 0);
    assert.equal((await feed()).unreadNotShown, 0);
    await notify(id, 3);
    assert.equal(getUnreadCount(id), 3, "only what arrived after the read");
  });

  it("evicting already-read notifications adds nothing", async () => {
    const id = seed("claude-code");
    await notify(id, 50);
    markRead(id);
    await notify(id, 30); // pushes 30 READ items out of retention
    assert.equal(getUnreadCount(id), 30);
  });

  it("retracting one retained warning drops exactly one, not the evicted count", async () => {
    const id = seed("claude-code");
    await notify(id, 74);
    const warn = pushSystemNotification(id, "transient");
    assert.equal(getUnreadCount(id), 75);
    assert.equal(retractSystemNotification(id, warn), true);
    assert.equal(getUnreadCount(id), 74, "the 25 evicted unread still count");
  });

  it("retracting a warning that scrolled out while unread takes it off the count", async () => {
    const id = seed("claude-code");
    const warn = pushSystemNotification(id, "may have failed to boot");
    await notify(id, 60); // the warning is now evicted
    assert.equal(
      getNotifications(id).some((n) => n.id === warn),
      false,
      "precondition: the warning is no longer retained",
    );
    assert.equal(getUnreadCount(id), 61);
    assert.equal(retractSystemNotification(id, warn), true);
    assert.equal(getUnreadCount(id), 60);
    assert.equal(
      retractSystemNotification(id, warn),
      false,
      "a second retraction is a no-op",
    );
    assert.equal(getUnreadCount(id), 60);
  });

  it("a read evicted warning can't be retracted off a count it isn't in", async () => {
    const id = seed("claude-code");
    const warn = pushSystemNotification(id, "w");
    await notify(id, 60);
    markRead(id);
    await notify(id, 2);
    assert.equal(retractSystemNotification(id, warn), false);
    assert.equal(getUnreadCount(id), 2);
  });

  it("retracting every retained row keeps the evicted count in the feed and badge", async () => {
    const id = seed("claude-code");
    setAgentStatus(id, "working");
    const warns: string[] = [];
    for (let i = 0; i < 60; i++)
      warns.push(pushSystemNotification(id, `w${i}`));
    // the last 50 are retained; retract exactly those
    for (const w of warns.slice(10)) retractSystemNotification(id, w);
    assert.equal(getNotifications(id).length, 0, "precondition: list emptied");
    // ...the first 10 were evicted, and retracting them is still possible,
    // but leave them: the 10 must still show on both surfaces.
    assert.equal(getUnreadCount(id), 10);
    const f = await feed();
    assert.equal(f.totalUnread, 10, "bell still counts the session");
    assert.equal(f.unreadBySession?.[id], 10);
    assert.equal(getAgentStatusSnapshot()[id]?.unread, 10, "badge agrees");

    let pushed = -1;
    const unsubscribe = onAgentDelta((d: AgentDelta) => {
      if (d.type === "agent.status" && d.id === id) pushed = d.unread;
    });
    try {
      markRead(id);
    } finally {
      unsubscribe();
    }
    assert.equal(pushed, 0, "markRead pushes the cleared count live");
    assert.equal(getUnreadCount(id), 0);
  });

  it("the feed names every session with unread, even one with no row on its page", async () => {
    const old = seed("claude-code");
    const busy = seed("gemini-cli");
    await notify(old, 75);
    // Strictly newer timestamps for the rest (a same-ms tie would sort the old
    // session first); the precondition below asserts the outcome.
    await new Promise((r) => setTimeout(r, 5));
    // 2 newer sessions × 50 retained fill the feed's 100-row page.
    await notify(busy, 50);
    const busy2 = seed("claude-code");
    await notify(busy2, 50);
    const f = await feed();
    assert.equal(
      f.notifications.some((n) => n.sessionId === old),
      false,
      "precondition: the old session has no row on the page",
    );
    assert.equal(f.unreadBySession?.[old], 75);
    assert.equal(f.totalUnread, 175);
    assert.equal(f.unreadNotShown, 75);
  });

  it("clearNotifications zeroes the evicted part too", async () => {
    const id = seed("claude-code");
    await notify(id, 75);
    clearNotifications(id);
    assert.equal(getUnreadCount(id), 0);
  });
});

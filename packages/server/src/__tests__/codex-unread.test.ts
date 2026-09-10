/**
 * Codex unread (#num) badge + bell-panel consistency (F3, supersedes #358's
 * content-less Stop). Codex fires no hooks, so a completed turn is surfaced by
 * reading the agent's REPLY off its rollout at the working→idle boundary and
 * appending it as a user-facing "AgentMessage" notification — so the turn BOTH
 * counts toward the badge AND shows in the panel with content, like a CC
 * SendUserMessage. `handleCodexActivity(flush=true)` → readAgentMessage(threadId)
 * → `noteAgentMessage` → the shared append/getUnreadCount/markRead machinery.
 *
 * Pins: a turn WITH a reply increments; a mid-turn observation (flush=false) or
 * a turn whose reply isn't readable yet does NOT (best-effort); markRead clears;
 * the notification carries the reply text; the live-push status-entry invariant.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDelta, UUID } from "@autonomos/core";

// UNCONDITIONAL (not ??=): worker agents inherit AUTONOMOS_CONFIG_DIR=<real dir>.
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-codex-unread-${randomUUID()}`;

const {
  handleCodexActivity,
  _setCodexAgentMessageReaderForTesting,
  _resetCodexUnreadDedupForTesting,
} = await import("../gateway/index.js");
const { onAgentDelta } = await import("../events/agents.js");
const { buildAgent, insertAgent, patchAgent, _resetCacheForTesting } =
  await import("../agents/store.js");
const {
  clearAgentState,
  clearNotifications,
  getNotifications,
  getUnreadCount,
  markRead,
  setAgentStatus,
} = await import("../routes/hooks.js");

const ids: string[] = [];
/** A running codex agent WITH a providerThreadId (handleCodexActivity reads it
 *  to locate the rollout). */
function seedCodex(): string {
  const id = randomUUID();
  ids.push(id);
  insertAgent(
    buildAgent({
      id: id as UUID,
      name: "Codex",
      workingDirectory: "/tmp",
      provider: "codex",
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  // providerThreadId isn't a buildAgent field — set it the way codexControl does.
  // The reader is stubbed, so any truthy id works; it just has to be present so
  // handleCodexActivity attempts the read.
  patchAgent(id as UUID, { providerThreadId: id });
  return id;
}

beforeEach(() => {
  _resetCacheForTesting();
  _resetCodexUnreadDedupForTesting();
  // Default: each completed turn is a DISTINCT occurrence (new ts), so the
  // ts-keyed dedup guard doesn't collapse them.
  let n = 0;
  _setCodexAgentMessageReaderForTesting(() => {
    n++;
    return { message: `reply ${n}`, ts: `ts-${n}` };
  });
});
afterEach(() => {
  _setCodexAgentMessageReaderForTesting(null);
  _resetCodexUnreadDedupForTesting();
  for (const id of ids.splice(0)) {
    clearNotifications(id);
    clearAgentState(id);
  }
  _resetCacheForTesting();
});

describe("Codex unread — turn-complete appends the agent message", () => {
  it("a completed turn (flush=true) with a reply increments unread 0 → 1", () => {
    const id = seedCodex();
    assert.equal(getUnreadCount(id), 0, "fresh agent starts at 0");
    handleCodexActivity(id, Date.now(), true);
    assert.equal(getUnreadCount(id), 1, "one completed turn = one unread");
  });

  it("the notification carries the reply TEXT as a user-facing AgentMessage", () => {
    const id = seedCodex();
    _setCodexAgentMessageReaderForTesting(() => ({
      message: "done: 3 files changed",
      ts: "t1",
    }));
    handleCodexActivity(id, Date.now(), true);
    const n = getNotifications(id).at(-1);
    assert.ok(n);
    assert.equal(n.event, "AgentMessage");
    assert.equal(n.message, "done: 3 files changed");
  });

  it("a mid-turn observation (flush=false) does NOT append", () => {
    const id = seedCodex();
    handleCodexActivity(id, Date.now(), false);
    handleCodexActivity(id, Date.now() + 1, false);
    assert.equal(getUnreadCount(id), 0, "activity without a turn boundary");
  });

  it("a turn whose reply isn't readable yet does NOT bump (best-effort)", () => {
    const id = seedCodex();
    _setCodexAgentMessageReaderForTesting(() => null); // not flushed / no rollout
    handleCodexActivity(id, Date.now(), true);
    assert.equal(
      getUnreadCount(id),
      0,
      "no reply text → no phantom notification, never a crash",
    );
  });

  it("a stale RE-READ (same ts) is NOT re-posted (flush-race guard — no wrong content)", () => {
    // A turn's idle edge fires before its reply is flushed → the reader returns
    // the PREVIOUS turn's reply, SAME rollout line = SAME ts. Re-posting it would
    // surface stale content as new. Same ts on two flushes → second skipped.
    const id = seedCodex();
    _setCodexAgentMessageReaderForTesting(() => ({
      message: "the previous reply",
      ts: "stale-ts",
    }));
    handleCodexActivity(id, Date.now(), true);
    handleCodexActivity(id, Date.now() + 1, true);
    assert.equal(getUnreadCount(id), 1, "same-ts re-read is deduped");
  });

  it("a genuinely-repeated reply (same text, NEW ts) DOES count (nox — no permanent swallow)", () => {
    // A cron Codex agent that answers "Done." every run must count each run. The
    // dedup keys on ts (occurrence), not text, so identical text with a new ts
    // still surfaces — the bug where content-dedup swallowed it forever.
    const id = seedCodex();
    let t = 0;
    _setCodexAgentMessageReaderForTesting(() => ({
      message: "Done.",
      ts: `run-${++t}`,
    }));
    handleCodexActivity(id, Date.now(), true);
    handleCodexActivity(id, Date.now() + 1, true);
    handleCodexActivity(id, Date.now() + 2, true);
    assert.equal(getUnreadCount(id), 3, "each run's identical reply counts");
  });

  it("markRead (pane-view) clears the unread", () => {
    const id = seedCodex();
    handleCodexActivity(id, Date.now(), true);
    assert.equal(getUnreadCount(id), 1);
    markRead(id);
    assert.equal(getUnreadCount(id), 0);
  });

  it("successive completed turns accumulate, then clear as a group", () => {
    const id = seedCodex();
    handleCodexActivity(id, Date.now(), true);
    handleCodexActivity(id, Date.now() + 1, true);
    handleCodexActivity(id, Date.now() + 2, true);
    assert.equal(getUnreadCount(id), 3);
    markRead(id);
    assert.equal(getUnreadCount(id), 0);
  });

  it("emits an agent.status delta carrying the bumped unread (live badge update)", () => {
    const id = seedCodex();
    setAgentStatus(id, "working"); // gives it an agentStates entry, as the real sink does
    const seen: AgentDelta[] = [];
    const off = onAgentDelta((d) => {
      if (d.type === "agent.status" && d.id === id) seen.push(d);
    });
    handleCodexActivity(id, Date.now(), true);
    off();
    const last = seen.at(-1);
    assert.ok(last && last.type === "agent.status");
    assert.equal(last.unread, 1);
  });

  it("the live-push invariant: without a status entry the count is still correct, but no delta fires", () => {
    const id = seedCodex();
    const seen: AgentDelta[] = [];
    const off = onAgentDelta((d) => {
      if (d.type === "agent.status" && d.id === id) seen.push(d);
    });
    handleCodexActivity(id, Date.now(), true); // no setAgentStatus first
    off();
    assert.equal(
      getUnreadCount(id),
      1,
      "count correct — read from notifications",
    );
    assert.equal(seen.length, 0, "no live delta without a status entry");
  });
});

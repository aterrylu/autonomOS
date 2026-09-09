/**
 * Codex unread (#num) badge — Codex fires no hooks, so its completed turns never
 * bumped the unread count that CC/Gemini get from their `Stop` hook (Terry's bug,
 * 2026-09-08). The fix routes the Codex working→idle turn boundary through the
 * SAME notification/unread path: `handleCodexActivity(..., flush=true)` →
 * `noteAgentTurnComplete` → the shared append/getUnreadCount/markRead machinery.
 *
 * These pin the three invariants: a completed turn increments, `markRead` (on
 * pane-view) clears, and — the birth-date invariant's sibling — a mid-turn
 * observation (flush=false) or an agent with no completed turn stays at 0.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { AgentDelta } from "@autonomos/core";

// UNCONDITIONAL (not ??=): worker agents inherit AUTONOMOS_CONFIG_DIR=<real dir>.
process.env.AUTONOMOS_CONFIG_DIR = `/tmp/aos-codex-unread-${randomUUID()}`;

const { handleCodexActivity } = await import("../gateway/index.js");
const { onAgentDelta } = await import("../events/agents.js");
const {
  clearAgentState,
  clearNotifications,
  getUnreadCount,
  markRead,
  setAgentStatus,
} = await import("../routes/hooks.js");

const ids: string[] = [];
function freshId(): string {
  const id = randomUUID();
  ids.push(id);
  return id;
}
afterEach(() => {
  for (const id of ids.splice(0)) {
    clearNotifications(id);
    clearAgentState(id);
  }
});

describe("Codex unread — turn-complete bumps the badge", () => {
  it("a completed turn (flush=true) increments unread 0 → 1", () => {
    const id = freshId();
    assert.equal(getUnreadCount(id), 0, "fresh agent starts at 0");
    handleCodexActivity(id, Date.now(), true);
    assert.equal(getUnreadCount(id), 1, "one completed turn = one unread");
  });

  it("a mid-turn observation (flush=false) does NOT bump — the no-completed-turn invariant", () => {
    const id = freshId();
    handleCodexActivity(id, Date.now(), false); // "working" advance, not a turn end
    handleCodexActivity(id, Date.now() + 1, false);
    assert.equal(
      getUnreadCount(id),
      0,
      "activity without a working→idle boundary must not count as a message",
    );
  });

  it("markRead (pane-view) clears the unread", () => {
    const id = freshId();
    handleCodexActivity(id, Date.now(), true);
    assert.equal(getUnreadCount(id), 1);
    markRead(id);
    assert.equal(getUnreadCount(id), 0, "viewing the pane clears it");
  });

  it("successive completed turns accumulate, then clear as a group", () => {
    const id = freshId();
    handleCodexActivity(id, Date.now(), true);
    handleCodexActivity(id, Date.now() + 1, true);
    handleCodexActivity(id, Date.now() + 2, true);
    assert.equal(getUnreadCount(id), 3, "three turns → three unread");
    markRead(id);
    assert.equal(getUnreadCount(id), 0);
  });

  it("emits an agent.status delta carrying the bumped unread (live badge update)", () => {
    const id = freshId();
    // The Codex status feed sets the agent's status first (gives it an
    // agentStates entry), exactly as the real sink does before the flush.
    setAgentStatus(id, "working");
    const seen: AgentDelta[] = [];
    const off = onAgentDelta((d) => {
      if (d.type === "agent.status" && d.id === id) seen.push(d);
    });
    handleCodexActivity(id, Date.now(), true);
    off();
    const last = seen.at(-1);
    assert.ok(last && last.type === "agent.status");
    assert.equal(last.unread, 1, "the delta carries the new unread count");
  });

  it("the live-push invariant: without a status entry the count is still correct, but no delta fires", () => {
    // emitStatusDelta intentionally stays silent for a session with no
    // agentStates entry (it must not emit for a session that never reported
    // status). The real Codex sink never hits this — a working→idle flush always
    // follows a "working" that created the entry — but this pins the documented
    // contract so a future status-less caller's behavior is explicit, not a
    // surprise: the persisted count is right, only the LIVE push is skipped.
    const id = freshId();
    const seen: AgentDelta[] = [];
    const off = onAgentDelta((d) => {
      if (d.type === "agent.status" && d.id === id) seen.push(d);
    });
    handleCodexActivity(id, Date.now(), true); // no setAgentStatus first
    off();
    assert.equal(
      getUnreadCount(id),
      1,
      "count is correct regardless — read from the notifications map, not agentStates",
    );
    assert.equal(
      seen.length,
      0,
      "no live delta without a status entry (the invariant), never a wrong count",
    );
  });
});

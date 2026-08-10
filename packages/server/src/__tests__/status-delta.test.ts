/**
 * Push migration (consolidation PR A): every activity-status or unread-count
 * change must emit an `agent.status` delta on the /ws/agents bus — this is
 * what lets the dashboard retire its 3s status poll. The emission chokepoint
 * is routes/hooks.ts `emitStatusDelta`, fed by hook ingest, the Codex daemon
 * feed (setAgentStatus), and every unread mutation.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDelta } from "@autonomos/core";

process.env.AUTONOMOS_CONFIG_DIR ??= `/tmp/aos-status-delta-${randomUUID()}`;

const { onAgentDelta } = await import("../events/agents.js");
const {
  clearAgentState,
  clearNotifications,
  getAgentStatusSnapshot,
  markRead,
  pushSystemNotification,
  retractSystemNotification,
  setAgentStatus,
} = await import("../routes/hooks.js");

const SID = "dddddddd-eeee-ffff-0000-111122223333";

describe("agent.status deltas (push migration)", () => {
  let seen: AgentDelta[] = [];
  let unsubscribe: () => void = () => {};

  beforeEach(() => {
    seen = [];
    unsubscribe = onAgentDelta((d) => {
      if (d.type === "agent.status" && d.id === SID) seen.push(d);
    });
  });
  afterEach(() => {
    unsubscribe();
    clearAgentState(SID);
    clearNotifications(SID);
  });

  it("a status change emits the full state + unread + ts", () => {
    setAgentStatus(SID, "working");
    assert.equal(seen.length, 1);
    const d = seen[0];
    assert.ok(d.type === "agent.status");
    assert.equal(d.state.status, "working");
    assert.equal(d.unread, 0);
    assert.ok(d.ts > 0);
  });

  it("a REPEATED status is not re-emitted (no churn)", () => {
    setAgentStatus(SID, "working");
    setAgentStatus(SID, "working");
    assert.equal(seen.length, 1);
  });

  it("unread mutations emit: notification append, markRead, retraction", () => {
    setAgentStatus(SID, "working"); // state must exist for unread deltas
    seen = [];
    const nid = pushSystemNotification(SID, "hello");
    assert.equal(seen.length, 1, "append emits");
    assert.ok(seen[0].type === "agent.status" && seen[0].unread === 1);

    markRead(SID);
    assert.equal(seen.length, 2, "markRead emits");
    assert.ok(seen[1].type === "agent.status" && seen[1].unread === 0);

    retractSystemNotification(SID, nid);
    assert.equal(seen.length, 3, "retraction emits");
  });

  it("a notification for a session with NO state does not emit (no orphan deltas)", () => {
    pushSystemNotification("99999999-9999-9999-9999-999999999999", "x");
    assert.equal(seen.length, 0);
  });

  it("the reconcile snapshot carries state + unread for known sessions", () => {
    setAgentStatus(SID, "working");
    pushSystemNotification(SID, "n1");
    const snap = getAgentStatusSnapshot();
    assert.equal(snap[SID]?.state.status, "working");
    assert.equal(snap[SID]?.unread, 1);
  });
});

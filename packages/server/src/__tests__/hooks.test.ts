import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearAgentState,
  clearNotifications,
  getAgentState,
  hooksRouter,
} from "../routes/hooks.js";

// Helper: simulate a hook event POST
async function postHookEvent(
  sessionId: string,
  event: Record<string, unknown>,
) {
  return hooksRouter.request(`/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

describe("hooks — agent status derivation", () => {
  const sid = "test-session-001";

  afterEach(() => {
    clearNotifications(sid);
    clearAgentState(sid);
  });

  it("SessionStart → ready", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionStart" });
    assert.equal(getAgentState(sid).status, "ready");
  });

  it("UserPromptSubmit → working", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PreToolUse → tool_running with tool name", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    const state = getAgentState(sid);
    assert.equal(state.status, "tool_running");
    assert.equal(state.currentTool, "Bash");
    assert.equal(state.toolDetail, "npm test");
  });

  it("PostToolUse → working (clears tool)", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    await postHookEvent(sid, { hook_event_name: "PostToolUse" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
  });

  it("Stop → idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("Notification (permission_prompt) → needs_input", async () => {
    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("Notification (non-permission) → no status change", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PermissionRequest → needs_input", async () => {
    await postHookEvent(sid, { hook_event_name: "PermissionRequest" });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("SubagentStart → orchestrating", async () => {
    await postHookEvent(sid, { hook_event_name: "SubagentStart" });
    assert.equal(getAgentState(sid).status, "orchestrating");
  });

  it("SubagentStop → working (exits orchestrating)", async () => {
    await postHookEvent(sid, { hook_event_name: "SubagentStart" });
    assert.equal(getAgentState(sid).status, "orchestrating");
    await postHookEvent(sid, { hook_event_name: "SubagentStop" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PreCompact → compacting", async () => {
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "compacting");
  });

  it("PostCompact from unknown baseline → ready (fallback)", async () => {
    // No prior status — PreCompact from "unknown" doesn't save a baseline.
    // PostCompact falls back to "ready" so the UI doesn't spin forever.
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "ready");
  });

  it("PreCompact → PostCompact restores pre-compact working status", async () => {
    // Mid-turn /compact: agent was working, stays working after compaction.
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
    assert.equal(state.toolDetail, undefined);
    // Baseline must be cleared — a stale baseline would corrupt later cycles.
    assert.equal(state.preCompactStatus, undefined);
  });

  it("SessionStart source=compact → PostCompact → ready (resume auto-compact)", async () => {
    // Regression: after server restart, sessions auto-compact on resume.
    // Previously stuck at "working" forever; now falls back to "ready".
    await postHookEvent(sid, {
      hook_event_name: "SessionStart",
      source: "compact",
    });
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "ready");
  });

  it("tool_running → PreCompact → PostCompact coerces to working (stale tool)", async () => {
    // The in-flight tool is gone after compaction — don't show stale tool.
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    assert.equal(getAgentState(sid).status, "tool_running");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, undefined);
    assert.equal(state.toolDetail, undefined);
  });

  it("needs_input → PreCompact → PostCompact coerces to working (stale prompt)", async () => {
    // A permission prompt in flight before compaction is gone afterward —
    // restore to working so the UI doesn't show a phantom prompt badge.
    await postHookEvent(sid, { hook_event_name: "PermissionRequest" });
    assert.equal(getAgentState(sid).status, "needs_input");
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("compacting → Stop → idle clears preCompactStatus (no leak across cycles)", async () => {
    // User cancels mid-compact. Baseline must not leak into the next cycle.
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    await postHookEvent(sid, { hook_event_name: "Stop" });
    const state = getAgentState(sid);
    assert.equal(state.status, "idle");
    assert.equal(state.preCompactStatus, undefined);
  });

  it("SessionEnd → stopped", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("PostToolUseFailure → working (agent continues after tool error)", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "failing-cmd" },
    });
    const state = getAgentState(sid);
    assert.equal(state.status, "working");
    assert.equal(state.currentTool, "Bash");
  });

  it("unknown event → status unchanged", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");
    await postHookEvent(sid, { hook_event_name: "SomeNewEvent" });
    assert.equal(getAgentState(sid).status, "idle"); // unchanged
  });

  it("unknown session → default state", () => {
    const state = getAgentState("nonexistent");
    assert.equal(state.status, "unknown");
    assert.equal(state.lastEvent, "");
  });
});

describe("hooks — sticky idle state", () => {
  const sid = "test-sticky-001";

  afterEach(() => {
    clearNotifications(sid);
    clearAgentState(sid);
  });

  it("PostToolUse after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    // Late PostToolUse (e.g., from recap or delayed event) should be ignored
    await postHookEvent(sid, { hook_event_name: "PostToolUse" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("SubagentStop after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "SubagentStop" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("PostCompact after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("PostToolUseFailure after Stop does NOT override idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
    });
    assert.equal(getAgentState(sid).status, "idle");
  });

  it("UserPromptSubmit CAN exit idle (new turn)", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    assert.equal(getAgentState(sid).status, "working");
  });

  it("PreToolUse CAN exit idle (agent resumed work)", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
    });
    assert.equal(getAgentState(sid).status, "tool_running");
  });

  it("SessionEnd CAN exit idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("PermissionRequest CAN exit idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, { hook_event_name: "PermissionRequest" });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("Notification (permission_prompt) CAN exit idle", async () => {
    await postHookEvent(sid, { hook_event_name: "Stop" });
    assert.equal(getAgentState(sid).status, "idle");

    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    assert.equal(getAgentState(sid).status, "needs_input");
  });

  it("stopped is also sticky — PostToolUse ignored", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");

    await postHookEvent(sid, { hook_event_name: "PostToolUse" });
    assert.equal(getAgentState(sid).status, "stopped");
  });

  it("SessionStart CAN exit stopped (session resumed)", async () => {
    await postHookEvent(sid, { hook_event_name: "SessionEnd" });
    assert.equal(getAgentState(sid).status, "stopped");

    await postHookEvent(sid, { hook_event_name: "SessionStart" });
    assert.equal(getAgentState(sid).status, "ready");
  });
});

describe("hooks — notifications", () => {
  const sid = "test-notif-001";

  afterEach(() => {
    clearNotifications(sid);
  });

  it("Stop event creates a notification", async () => {
    const res = await postHookEvent(sid, { hook_event_name: "Stop" });
    const body = await res.json();
    assert.equal(body.ok, true);
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread, 1);
  });

  it("Notification event creates a notification", async () => {
    // Ensure agent has state so bulk endpoint includes it
    await postHookEvent(sid, { hook_event_name: "UserPromptSubmit" });
    clearNotifications(sid);
    await postHookEvent(sid, { hook_event_name: "Notification" });
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread, 1);
  });

  it("PreToolUse does NOT create a notification", async () => {
    await postHookEvent(sid, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread ?? 0, 0);
  });
});

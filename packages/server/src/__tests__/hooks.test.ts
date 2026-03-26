import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearNotifications,
  getAgentState,
  hooksRouter,
} from "../routes/hooks.js";

// Helper: simulate a hook event POST
async function postHookEvent(
  sessionId: string,
  event: Record<string, unknown>,
) {
  const req = new Request(`http://localhost/api/hooks/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  // Use Hono's fetch to test the route
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

  it("Notification (idle_prompt) → idle", async () => {
    await postHookEvent(sid, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
    });
    assert.equal(getAgentState(sid).status, "idle");
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

  it("PostCompact → working (exits compacting)", async () => {
    await postHookEvent(sid, { hook_event_name: "PreCompact" });
    assert.equal(getAgentState(sid).status, "compacting");
    await postHookEvent(sid, { hook_event_name: "PostCompact" });
    assert.equal(getAgentState(sid).status, "working");
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

describe("hooks — notifications", () => {
  const sid = "test-notif-001";

  afterEach(() => {
    clearNotifications(sid);
  });

  it("Stop event creates a notification", async () => {
    const res = await postHookEvent(sid, { hook_event_name: "Stop" });
    const body = await res.json();
    assert.equal(body.ok, true);
    // Check via the bulk endpoint
    const bulk = await hooksRouter.request("/", { method: "GET" });
    const data = (await bulk.json()) as Record<string, { unread: number }>;
    assert.equal(data[sid]?.unread, 1);
  });

  it("Notification event creates a notification", async () => {
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

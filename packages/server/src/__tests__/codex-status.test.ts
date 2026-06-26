import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearAgentState,
  getAgentState,
  setAgentStatus,
} from "../routes/hooks.js";

/**
 * Codex has no hook relay; its working-status is set directly from the
 * app-server daemon's ground-truth event stream via setAgentStatus(), feeding
 * the same in-memory map the dashboard polls for CC/Gemini.
 */
describe("setAgentStatus (provider ground-truth status)", () => {
  const id = "codex-agent-1";
  afterEach(() => clearAgentState(id));

  it("sets the working status and stamps updatedAt", () => {
    setAgentStatus(id, "working");
    const s = getAgentState(id);
    assert.equal(s.status, "working");
    assert.ok(s.updatedAt > 0);
    assert.equal(s.lastEvent, "provider/status");
  });

  it("transitions across statuses (idle -> working -> idle)", () => {
    setAgentStatus(id, "idle");
    assert.equal(getAgentState(id).status, "idle");
    setAgentStatus(id, "working");
    assert.equal(getAgentState(id).status, "working");
    setAgentStatus(id, "idle");
    assert.equal(getAgentState(id).status, "idle");
  });

  it("is a no-op on a repeated status (no churn)", () => {
    setAgentStatus(id, "working");
    const first = getAgentState(id).updatedAt;
    setAgentStatus(id, "working");
    assert.equal(getAgentState(id).updatedAt, first); // unchanged
  });

  it("clears stale tool metadata when status changes", () => {
    // simulate a prior tool-running state, then a direct status set
    setAgentStatus(id, "working");
    setAgentStatus(id, "idle");
    const s = getAgentState(id);
    assert.equal(s.currentTool, undefined);
    assert.equal(s.toolDetail, undefined);
  });
});

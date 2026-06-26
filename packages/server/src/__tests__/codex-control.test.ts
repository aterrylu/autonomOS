import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatInbound } from "../gateway/codexControl.js";

/**
 * Codex inbound is injected as an attributed user turn into the agent's
 * app-server daemon, mirroring Claude Code's channel formatting
 * (`[Name → you via agent://Name]\n<text>`) so the fleet reads consistently.
 */
describe("codex inbound formatting", () => {
  it("wraps the message with sender attribution + URI, CC-style", () => {
    const out = formatInbound(
      "Bar@autonomOS",
      "agent://Bar@autonomOS",
      "can you review PR #42?",
    );
    assert.equal(
      out,
      "[Bar@autonomOS → you via agent://Bar@autonomOS]\ncan you review PR #42?",
    );
  });

  it("preserves multi-line message bodies", () => {
    const out = formatInbound("X", "agent://X", "line1\nline2");
    assert.ok(out.startsWith("[X → you via agent://X]\n"));
    assert.ok(out.endsWith("line1\nline2"));
  });
});

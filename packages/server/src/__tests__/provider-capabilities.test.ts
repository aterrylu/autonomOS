import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeCodeProvider } from "../providers/claude-code.js";
import { codexProvider } from "../providers/codex.js";
import { geminiCliProvider } from "../providers/gemini-cli.js";

/**
 * Guards the `liveStatus` capability — the create-agent UI shows a "Live
 * status" row from `caps.liveStatus.supported`, decoupled from `hooks` so a
 * provider that sources status from somewhere other than a hook relay (Codex's
 * app-server event stream) isn't mislabeled as having no live status.
 */
describe("provider liveStatus capability", () => {
  it("claude-code reports live status via hooks", () => {
    assert.deepEqual(claudeCodeProvider.capabilities.liveStatus, {
      supported: true,
      method: "hooks",
    });
  });

  it("codex reports live status via the event stream (not hooks)", () => {
    const { liveStatus, hooks } = codexProvider.capabilities;
    assert.deepEqual(liveStatus, { supported: true, method: "event-stream" });
    // Regression: Codex has zero hook events but still supports live status.
    assert.equal(hooks.eventCount, 0);
    assert.equal(liveStatus.supported, true);
  });

  it("gemini-cli reports live status via hooks", () => {
    assert.deepEqual(geminiCliProvider.capabilities.liveStatus, {
      supported: true,
      method: "hooks",
    });
  });
});

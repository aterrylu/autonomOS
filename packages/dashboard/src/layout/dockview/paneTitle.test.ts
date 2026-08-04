import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../store";
import { paneTitle, SINGLETON_PANES } from "./paneId";

/**
 * A new pane type must be registered in FOUR places (SINGLETON_PANES, the
 * PaneContent switch, the Sidebar nav, and paneTitle). The `presets` tab shipped
 * with the first three but not paneTitle, so it rendered "Unknown (presets)".
 * This locks the title mapping to the SINGLETON_PANES source of truth: any
 * future singleton without a title case fails here, not in a user's face.
 */
describe("paneTitle", () => {
  it("every singleton pane type has a real (non-Unknown) title", () => {
    for (const pane of Object.values(SINGLETON_PANES)) {
      const title = paneTitle(pane, []);
      expect(title, `singleton "${pane.type}" must have a title`).not.toMatch(
        /^Unknown/,
      );
      expect(title.length).toBeGreaterThan(0);
    }
  });

  it("titles the presets tab 'Presets' (regression: was 'Unknown (presets)')", () => {
    expect(paneTitle(SINGLETON_PANES.presets, [])).toBe("Presets");
  });

  it("resolves a session pane to its name, else a short id", () => {
    const sessions = [{ id: "abc123", name: "Worker" }] as SessionInfo[];
    expect(paneTitle({ type: "session", id: "abc123" }, sessions)).toBe(
      "Worker",
    );
    expect(paneTitle({ type: "session", id: "deadbeef9999" }, [])).toBe(
      "deadbeef",
    );
  });

  it("falls back to Unknown (type) only for a retired/absent pane", () => {
    expect(paneTitle({ type: "preview", id: "x" } as never, [])).toBe(
      "Unknown (preview)",
    );
    expect(paneTitle(undefined, [])).toBe("Unknown (undefined)");
  });
});

import { describe, expect, it, vi } from "vitest";

// We can't easily mock `isMac` since it's evaluated at module load time.
// Instead, test the modifier logic directly against the exported function.
// On CI (Linux), isMac = false, so Ctrl is the primary modifier.

describe("hasPrimaryModifier", () => {
  // Dynamic import so we can test the actual runtime value
  it("returns boolean based on platform modifier key", async () => {
    const { hasPrimaryModifier, isMac } = await import("./platform");

    const ctrlEvent = { metaKey: false, ctrlKey: true };
    const metaEvent = { metaKey: true, ctrlKey: false };
    const neitherEvent = { metaKey: false, ctrlKey: false };
    const bothEvent = { metaKey: true, ctrlKey: true };

    if (isMac) {
      expect(hasPrimaryModifier(metaEvent)).toBe(true);
      expect(hasPrimaryModifier(ctrlEvent)).toBe(false);
    } else {
      expect(hasPrimaryModifier(ctrlEvent)).toBe(true);
      expect(hasPrimaryModifier(metaEvent)).toBe(false);
    }

    // Neither key → always false
    expect(hasPrimaryModifier(neitherEvent)).toBe(false);

    // Both keys → always true (one of the two branches is satisfied)
    expect(hasPrimaryModifier(bothEvent)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { resolveSidebarViewMode } from "./store";

// resolveSidebarViewMode decides which sidebar view to show on rehydration.
// The crux of the "default to hierarchical" feature: the persisted view wins
// ONLY when the user explicitly chose it. Everyone else — fresh installs AND
// existing installs whose default view was auto-persisted before the explicit
// flag existed — falls through to the default.

describe("resolveSidebarViewMode", () => {
  it("returns the default when there is no persisted state", () => {
    expect(resolveSidebarViewMode(undefined, "hierarchy")).toEqual({
      mode: "hierarchy",
      explicit: false,
    });
    expect(resolveSidebarViewMode(null, "hierarchy")).toEqual({
      mode: "hierarchy",
      explicit: false,
    });
    expect(resolveSidebarViewMode({}, "hierarchy")).toEqual({
      mode: "hierarchy",
      explicit: false,
    });
  });

  it("ignores a persisted view that was never explicitly chosen (the existing-user case)", () => {
    // An existing install: Zustand auto-persisted the old default "flat" even
    // though the user never touched the toggle. They must still get the new
    // hierarchical default.
    expect(
      resolveSidebarViewMode({ sidebarViewMode: "flat" }, "hierarchy"),
    ).toEqual({ mode: "hierarchy", explicit: false });
  });

  it("restores an explicitly chosen flat view", () => {
    expect(
      resolveSidebarViewMode(
        { sidebarViewMode: "flat", sidebarViewModeExplicit: true },
        "hierarchy",
      ),
    ).toEqual({ mode: "flat", explicit: true });
  });

  it("restores an explicitly chosen hierarchy view", () => {
    expect(
      resolveSidebarViewMode(
        { sidebarViewMode: "hierarchy", sidebarViewModeExplicit: true },
        "hierarchy",
      ),
    ).toEqual({ mode: "hierarchy", explicit: true });
  });

  it("treats an explicit flag with a missing/invalid view as not-explicit", () => {
    // A corrupted blob must never strand the user — fall back to the default
    // and report explicit=false so the flag gets re-derived from real choices.
    expect(
      resolveSidebarViewMode({ sidebarViewModeExplicit: true }, "hierarchy"),
    ).toEqual({ mode: "hierarchy", explicit: false });
    expect(
      resolveSidebarViewMode(
        { sidebarViewMode: "garbage", sidebarViewModeExplicit: true },
        "hierarchy",
      ),
    ).toEqual({ mode: "hierarchy", explicit: false });
  });

  it("honors the supplied default (does not hardcode hierarchy)", () => {
    expect(resolveSidebarViewMode({}, "flat")).toEqual({
      mode: "flat",
      explicit: false,
    });
  });

  it("a non-boolean explicit flag does not count as explicit", () => {
    // Only the literal boolean true marks an explicit choice; truthy strings
    // from a malformed blob must not flip the gate.
    expect(
      resolveSidebarViewMode(
        { sidebarViewMode: "flat", sidebarViewModeExplicit: "true" },
        "hierarchy",
      ),
    ).toEqual({ mode: "hierarchy", explicit: false });
  });
});

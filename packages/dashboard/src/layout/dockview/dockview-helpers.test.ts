import { describe, expect, it } from "vitest";
import { isDegenerate } from "../../terminal/resize";
import { paneFromId, SINGLETON_TYPES } from "./paneId";

// ── isDegenerate (PTY resize guard) ──────────────────────────────────
// The FitAddon floors at 2 cols / 1 row; a fit against an unsettled renderer
// can collapse to that floor. We must never propagate such a size to the PTY —
// that's the "terminal shrinks to a tiny state" bug. This pure guard decides it,
// so pin its boundary so a later "tidy" (<=2 → <2, or dropping one caller) can't
// silently reintroduce the shrink.
describe("isDegenerate", () => {
  it("flags the FitAddon floor and below", () => {
    expect(isDegenerate(2, 40)).toBe(true); // cols at floor
    expect(isDegenerate(1, 40)).toBe(true); // cols below floor
    expect(isDegenerate(80, 1)).toBe(true); // rows at floor
    expect(isDegenerate(80, 0)).toBe(true); // rows below floor
    expect(isDegenerate(2, 1)).toBe(true); // both degenerate
  });

  it("accepts plausible real terminal sizes", () => {
    expect(isDegenerate(3, 2)).toBe(false); // just above the floor
    expect(isDegenerate(80, 24)).toBe(false); // typical
    expect(isDegenerate(200, 50)).toBe(false); // large
  });
});

// ── paneFromId (dockview panel id → ActivePane) ──────────────────────
// Used on the dockview→store writeback path; a wrong classification renders the
// wrong surface. The id space is unambiguous: singleton id == its type, tracked
// preview ids → preview, everything else → session.
describe("paneFromId", () => {
  it("maps each singleton id to its own type", () => {
    for (const id of SINGLETON_TYPES) {
      expect(paneFromId(id, new Set())).toEqual({ type: id, id });
    }
  });

  it("maps a known preview id to a preview pane", () => {
    const previews = new Set(["preview-abc"]);
    expect(paneFromId("preview-abc", previews)).toEqual({
      type: "preview",
      id: "preview-abc",
    });
  });

  it("treats any other id as a session", () => {
    expect(paneFromId("9f3c-uuid-session", new Set())).toEqual({
      type: "session",
      id: "9f3c-uuid-session",
    });
  });
});

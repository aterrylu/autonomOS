import { describe, expect, it } from "vitest";
import { isDegenerate, isPlausibleFit } from "../../terminal/resize";
import { isValidActivePane, paneFromId, SINGLETON_TYPES } from "./paneId";

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

// ── isPlausibleFit (idle self-shrink guard) ──────────────────────────
// isDegenerate only blocks the 2×1 floor. The residual idle-shrink ships a
// small-but->2 mis-measure (e.g. 20 cols in an 800px pane → 40px cell) that
// sails through it and wedges the PTY. isPlausibleFit rejects any fit whose
// implied cell exceeds a sane monospace maximum, so callers retry instead of
// propagating garbage. Pin the boundary so the shrink can't creep back.
describe("isPlausibleFit", () => {
  it("accepts a normal fit (sane cell size)", () => {
    expect(isPlausibleFit(80, 24, 800, 480)).toBe(true); // ~10px × 20px cell
    expect(isPlausibleFit(5, 4, 60, 80)).toBe(true); // small but sane pane
  });

  it("rejects a too-few-columns mis-measure (cell too wide)", () => {
    // 20 cols in 800px ⇒ 40px cell — no real terminal font is that wide.
    expect(isPlausibleFit(20, 24, 800, 480)).toBe(false);
  });

  it("rejects a too-few-rows mis-measure (cell too tall)", () => {
    // 4 rows in 480px ⇒ 120px cell.
    expect(isPlausibleFit(80, 4, 800, 480)).toBe(false);
  });

  it("rejects the degenerate floor and a zero-size box", () => {
    expect(isPlausibleFit(2, 24, 800, 480)).toBe(false); // degenerate cols
    expect(isPlausibleFit(80, 24, 0, 480)).toBe(false); // hidden pane
    expect(isPlausibleFit(80, 24, 800, 0)).toBe(false);
  });
});

// ── isValidActivePane (persisted-blob guard, cluster A) ──────────────
// activePane is the one persisted layout field that reaches dockview's
// addPanel({ id }) on restore. A malformed shape throws there and re-persists,
// blanking the app on every reload. Reject anything that isn't a known union
// member so a bad blob degrades to "no active pane".
describe("isValidActivePane", () => {
  it("accepts well-formed session/preview panes", () => {
    expect(isValidActivePane({ type: "session", id: "s1" })).toBe(true);
    expect(isValidActivePane({ type: "preview", id: "preview-1" })).toBe(true);
  });

  it("accepts singletons only when id === type", () => {
    for (const id of SINGLETON_TYPES) {
      expect(isValidActivePane({ type: id, id })).toBe(true);
      expect(isValidActivePane({ type: id, id: "wrong" })).toBe(false);
    }
  });

  it("rejects malformed / legacy blobs", () => {
    expect(isValidActivePane(null)).toBe(false);
    expect(isValidActivePane(undefined)).toBe(false);
    expect(isValidActivePane("session")).toBe(false);
    expect(isValidActivePane({})).toBe(false);
    expect(isValidActivePane({ type: "session" })).toBe(false); // no id
    expect(isValidActivePane({ type: "session", id: "" })).toBe(false); // blank
    expect(isValidActivePane({ type: "leaf", id: "x" })).toBe(false); // legacy
    expect(isValidActivePane({ id: "s1" })).toBe(false); // no type
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

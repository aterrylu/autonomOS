import { describe, expect, it } from "vitest";
import { isDegenerate, isPlausibleFit } from "../../terminal/resize";
import {
  isValidActivePane,
  paneFromId,
  paneFromPanel,
  SINGLETON_TYPES,
} from "./paneId";

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
  it("accepts well-formed session panes", () => {
    expect(isValidActivePane({ type: "session", id: "s1" })).toBe(true);
  });

  // Backward-compat: the markdown preview feature persisted
  // `activePane: {type:"preview"}`. After its removal PaneContent has no
  // "preview" case, so accepting the shape here would restore a silently BLANK
  // pane. Rejecting it degrades the stale blob to "no active pane" instead.
  it("rejects a stale preview pane from the removed preview feature", () => {
    expect(isValidActivePane({ type: "preview", id: "preview-1" })).toBe(false);
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
// wrong surface. The id space is unambiguous: singleton id == its type,
// everything else → session.
describe("paneFromId", () => {
  it("maps each singleton id to its own type", () => {
    for (const id of SINGLETON_TYPES) {
      expect(paneFromId(id)).toEqual({ type: id, id });
    }
  });

  it("treats any other id as a session", () => {
    expect(paneFromId("9f3c-uuid-session")).toEqual({
      type: "session",
      id: "9f3c-uuid-session",
    });
  });
});

// ── paneFromPanel (writeback guard) ──────────────────────────────────
// `isValidActivePane` guards `activePane` on rehydrate, but dockview's toJSON
// also persists each panel's `params` inside `dvWorkspaces[*].serialized`, which
// is NOT validated. Without this guard, activating such a panel would write back
// `paneFromId(id)` = `{type:"session", id}` — a shape that then PASSES
// `isValidActivePane` on the next reload, laundering a retired pane into a
// terminal for a session id that never existed.
describe("paneFromPanel", () => {
  it("skips the writeback for a panel declaring a removed pane type", () => {
    expect(
      paneFromPanel("preview-1750000000000-1", {
        type: "preview",
        id: "preview-1750000000000-1",
      }),
    ).toBeNull();
  });

  it("skips the writeback for a malformed declared pane", () => {
    expect(paneFromPanel("x", { type: "session" })).toBeNull(); // no id
    expect(paneFromPanel("x", { type: "leaf", id: "x" })).toBeNull(); // legacy
  });

  it("classifies by id when the panel declares no pane", () => {
    expect(paneFromPanel("9f3c-uuid-session", undefined)).toEqual({
      type: "session",
      id: "9f3c-uuid-session",
    });
    for (const id of SINGLETON_TYPES) {
      expect(paneFromPanel(id, undefined)).toEqual({ type: id, id });
    }
  });

  it("accepts panels declaring a still-valid pane", () => {
    expect(paneFromPanel("s1", { type: "session", id: "s1" })).toEqual({
      type: "session",
      id: "s1",
    });
    expect(
      paneFromPanel("orgchart", { type: "orgchart", id: "orgchart" }),
    ).toEqual({ type: "orgchart", id: "orgchart" });
  });
});

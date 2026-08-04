import { describe, expect, it } from "vitest";
import { digitForPane } from "./paneDigits";

describe("digitForPane", () => {
  it("maps positions 0..7 to digits 1..8", () => {
    expect(digitForPane(0, 3)).toBe(1);
    expect(digitForPane(1, 3)).toBe(2);
    expect(digitForPane(7, 8)).toBe(8);
  });

  it("last pane shows its positional digit when ≤8 (mod+9 also reaches it, but the positional chord is the primary)", () => {
    expect(digitForPane(2, 3)).toBe(3);
    expect(digitForPane(7, 8)).toBe(8);
  });

  it("with exactly 9 panes, position 8 is the last pane → 9", () => {
    expect(digitForPane(8, 9)).toBe(9);
  });

  it("beyond 8 panes: only the LAST pane is reachable (9); the middle ones get no badge", () => {
    expect(digitForPane(8, 10)).toBeNull(); // 9th of 10 — unreachable
    expect(digitForPane(9, 10)).toBe(9); // last of 10 — mod+9
    expect(digitForPane(10, 12)).toBeNull();
    expect(digitForPane(11, 12)).toBe(9);
  });

  it("a lone pane needs no hint", () => {
    expect(digitForPane(0, 1)).toBeNull();
  });

  it("out-of-range indices are null", () => {
    expect(digitForPane(-1, 3)).toBeNull();
    expect(digitForPane(3, 3)).toBeNull();
  });
});

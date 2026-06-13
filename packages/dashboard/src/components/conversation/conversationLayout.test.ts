import type { Turn } from "@autonomos/core";
import { describe, expect, it } from "vitest";
import {
  decorateTurns,
  INITIAL_REVEAL,
  revealWindow,
  SIDECHAIN_COLORS,
} from "./conversationLayout";

function turn(role: Turn["role"], isSidechain = false): Turn {
  return { role, items: [], ...(isSidechain ? { isSidechain: true } : {}) };
}

describe("decorateTurns", () => {
  it("assigns one palette color per contiguous sidechain run and cycles", () => {
    const turns = [
      turn("user"),
      turn("assistant", true), // run 0 →
      turn("assistant", true), // ... same run
      turn("assistant"), // breaks the run
      turn("assistant", true), // run 1 → next color
    ];
    const d = decorateTurns(turns);

    // Both turns of the first run share color[0]
    expect(d[1].sidechainColor).toBe(SIDECHAIN_COLORS[0]);
    expect(d[2].sidechainColor).toBe(SIDECHAIN_COLORS[0]);
    // The second, separate run advances to color[1]
    expect(d[4].sidechainColor).toBe(SIDECHAIN_COLORS[1]);
  });

  it("flags only the first turn of each sidechain run for the header", () => {
    const turns = [
      turn("user"),
      turn("assistant", true),
      turn("assistant", true),
      turn("assistant"),
      turn("assistant", true),
    ];
    const d = decorateTurns(turns);

    expect(d[0].showSidechainHeader).toBe(false); // not a sidechain
    expect(d[1].showSidechainHeader).toBe(true); // start of run 0
    expect(d[2].showSidechainHeader).toBe(false); // mid run 0
    expect(d[4].showSidechainHeader).toBe(true); // start of run 1
  });

  it("preserves original indices as stable keys", () => {
    const turns = [turn("user"), turn("assistant"), turn("user")];
    expect(decorateTurns(turns).map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it("never indexes the palette out of bounds for a leading sidechain", () => {
    const d = decorateTurns([turn("assistant", true)]);
    expect(d[0].sidechainColor).toBe(SIDECHAIN_COLORS[0]);
    expect(SIDECHAIN_COLORS).toContain(d[0].sidechainColor);
  });
});

describe("revealWindow", () => {
  const decorated = decorateTurns(
    Array.from({ length: 100 }, () => turn("assistant")),
  );

  it("reveals from the END (most-recent turns first)", () => {
    const win = revealWindow(decorated, 10);
    expect(win).toHaveLength(10);
    expect(win[0].index).toBe(90); // last 10 → indices 90..99
    expect(win[9].index).toBe(99);
  });

  it("clamps to the full array when revealed exceeds length", () => {
    const win = revealWindow(decorated, 999);
    expect(win).toHaveLength(100);
    expect(win[0].index).toBe(0);
  });

  it("INITIAL_REVEAL keeps the first paint bounded", () => {
    expect(revealWindow(decorated, INITIAL_REVEAL)).toHaveLength(
      INITIAL_REVEAL,
    );
  });
});

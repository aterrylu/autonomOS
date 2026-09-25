import type { AgentTreeNode } from "@autonomos/core";
import { describe, expect, it } from "vitest";
import { applyCollapse, computeRollups, type RollupBucket } from "./teams";

const node = (id: string, ...children: AgentTreeNode[]): AgentTreeNode =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status: "running",
    provider: "claude-code",
    children,
  }) as AgentTreeNode;

const buckets: Record<string, RollupBucket> = {
  D: "working",
  F: "needsYou",
  u: "working",
  c: "idle",
  B: "exited",
  a: "working",
  t: "needsYou",
  e: "error",
};
const bucketOf = (n: AgentTreeNode) => buckets[n.id] ?? "idle";

const tree = () => [
  node(
    "D",
    node("F", node("u"), node("c")),
    node("B", node("a"), node("t"), node("e")),
  ),
  node("Solo"),
];

describe("computeRollups", () => {
  it("counts everyone UNDER a manager, not the manager itself", () => {
    const r = computeRollups(tree(), bucketOf);
    expect(r.get("F")).toEqual({
      needsYou: 0,
      working: 1,
      idle: 1,
      error: 0,
      exited: 0,
      total: 2,
    });
    // B is exited but the rollup is about its team: a, t, e.
    expect(r.get("B")).toEqual({
      needsYou: 1,
      working: 1,
      idle: 0,
      error: 1,
      exited: 0,
      total: 3,
    });
  });

  it("rolls up the WHOLE subtree for the top lead", () => {
    const d = computeRollups(tree(), bucketOf).get("D");
    expect(d).toEqual({
      needsYou: 2, // F + t
      working: 2, // u + a
      idle: 1, // c
      error: 1, // e
      exited: 1, // B
      total: 7,
    });
  });

  it("has no entry for leaves or solo agents", () => {
    const r = computeRollups(tree(), bucketOf);
    expect(r.has("u")).toBe(false);
    expect(r.has("Solo")).toBe(false);
  });
});

describe("applyCollapse", () => {
  it("folds a collapsed team but keeps the lead's card", () => {
    const roots = tree();
    const out = applyCollapse(roots, new Set(["F"]));
    const D = out[0];
    const F = D.children.find((c) => c.id === "F");
    expect(F?.children).toEqual([]);
    // The sibling team is untouched (same object).
    expect(D.children.find((c) => c.id === "B")).toBe(roots[0].children[1]);
  });

  it("ignores ids that aren't managers or don't exist (stale persisted state)", () => {
    const roots = tree();
    expect(applyCollapse(roots, new Set(["u", "ghost-id"]))).toEqual(roots);
    expect(applyCollapse(roots, new Set(["u", "ghost-id"]))[0]).toBe(roots[0]);
  });

  it("is a no-op with nothing collapsed", () => {
    const roots = tree();
    expect(applyCollapse(roots, new Set())).toBe(roots);
  });

  it("rollups computed BEFORE folding still see the folded team", () => {
    const roots = tree();
    const r = computeRollups(roots, bucketOf);
    applyCollapse(roots, new Set(["B"]));
    expect(r.get("B")?.needsYou).toBe(1);
  });
});

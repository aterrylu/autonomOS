import type { AgentTreeNode } from "@autonomos/core";
import { describe, expect, it } from "vitest";
import { pruneExited } from "./pruneExited";

const node = (
  id: string,
  status: "running" | "exited",
  ...children: AgentTreeNode[]
): AgentTreeNode =>
  ({
    id,
    claudeSessionId: id,
    name: id,
    status,
    provider: "claude-code",
    children,
  }) as AgentTreeNode;

const ids = (roots: AgentTreeNode[]): string[] =>
  roots.flatMap((r) => [r.id, ...ids(r.children)]);

describe("pruneExited", () => {
  it("keeps an exited manager whose team is still running, WITH its reports under it (F3)", () => {
    const tree = [
      node(
        "Dispatcher",
        "running",
        node("BackendLead", "exited", node("APIWorker", "running")),
      ),
    ];
    const { roots, hiddenExited } = pruneExited(tree, false);
    // The report stays under the ghost — never promoted to a root.
    expect(roots.map((r) => r.id)).toEqual(["Dispatcher"]);
    expect(roots[0].children[0].id).toBe("BackendLead");
    expect(roots[0].children[0].children[0].id).toBe("APIWorker");
    expect(hiddenExited).toBe(0);
  });

  it("hides exited agents that hold no running team, and counts them", () => {
    const tree = [
      node(
        "Lead",
        "running",
        node("DeadWorker", "exited"),
        node("DeadSub", "exited", node("DeadLeaf", "exited")),
        node("Live", "running"),
      ),
      node("OldSolo", "exited"),
    ];
    const { roots, hiddenExited } = pruneExited(tree, false);
    expect(ids(roots)).toEqual(["Lead", "Live"]);
    expect(hiddenExited).toBe(4);
  });

  it("shows everything when asked", () => {
    const tree = [
      node("Lead", "running", node("Dead", "exited")),
      node("Old", "exited"),
    ];
    const { roots, hiddenExited } = pruneExited(tree, true);
    expect(ids(roots)).toEqual(["Lead", "Dead", "Old"]);
    expect(hiddenExited).toBe(0);
  });

  it("never loses a running agent, whatever the mix", () => {
    const tree = [
      node(
        "x",
        "exited",
        node("y", "exited", node("z", "running")),
        node("w", "exited"),
      ),
    ];
    const { roots } = pruneExited(tree, false);
    expect(ids(roots)).toEqual(["x", "y", "z"]);
  });

  it("returns the same node objects when nothing under them was pruned", () => {
    const leaf = node("a", "running");
    const tree = [node("r", "running", leaf)];
    const { roots } = pruneExited(tree, false);
    expect(roots[0]).toBe(tree[0]);
  });
});

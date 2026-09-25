// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import "./test/setup-dom";
import type { AgentStatusMap } from "@autonomos/core";
import { applyStatusSnapshot, useStore } from "./store";

/**
 * applyStatusSnapshot structural sharing. Every push/poll snapshot arrives with
 * NEW entry objects for every agent; an unchanged agent must keep its previous
 * entry (and an unchanged map its previous reference), or every per-agent
 * subscriber re-renders on every status frame.
 */

const snap = (
  entries: Record<
    string,
    { status: string; currentTool?: string; unread?: number }
  >,
): AgentStatusMap =>
  Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [
      id,
      {
        status: { status: e.status, currentTool: e.currentTool },
        unread: e.unread ?? 0,
      },
    ]),
  ) as unknown as AgentStatusMap;

beforeEach(() => {
  useStore.setState({ agentStatuses: {}, notificationCounts: {} });
});

describe("applyStatusSnapshot structural sharing", () => {
  it("an unchanged agent keeps its previous entry object; the changed one is new", () => {
    applyStatusSnapshot(snap({ a: { status: "idle" }, b: { status: "idle" } }));
    const first = useStore.getState().agentStatuses;
    applyStatusSnapshot(
      snap({ a: { status: "idle" }, b: { status: "working" } }),
    );
    const second = useStore.getState().agentStatuses;
    expect(second).not.toBe(first);
    expect(second.a).toBe(first.a); // unchanged → same reference
    expect(second.b).not.toBe(first.b);
    expect(second.b?.status).toBe("working");
  });

  it("a snapshot identical in value commits nothing (both maps keep their references)", () => {
    applyStatusSnapshot(
      snap({ a: { status: "working", currentTool: "Bash", unread: 2 } }),
    );
    const { agentStatuses, notificationCounts } = useStore.getState();
    applyStatusSnapshot(
      snap({ a: { status: "working", currentTool: "Bash", unread: 2 } }),
    );
    expect(useStore.getState().agentStatuses).toBe(agentStatuses);
    expect(useStore.getState().notificationCounts).toBe(notificationCounts);
  });

  it("a status-only change keeps the counts map's reference (and vice versa)", () => {
    applyStatusSnapshot(snap({ a: { status: "idle", unread: 1 } }));
    const s1 = useStore.getState();
    applyStatusSnapshot(snap({ a: { status: "working", unread: 1 } }));
    const s2 = useStore.getState();
    expect(s2.notificationCounts).toBe(s1.notificationCounts);
    expect(s2.agentStatuses).not.toBe(s1.agentStatuses);
    applyStatusSnapshot(snap({ a: { status: "working", unread: 3 } }));
    const s3 = useStore.getState();
    expect(s3.agentStatuses).toBe(s2.agentStatuses);
    expect(s3.notificationCounts).not.toBe(s2.notificationCounts);
    expect(s3.notificationCounts.a).toBe(3);
  });

  it("a tool change on the same status is a change (currentTool is compared)", () => {
    applyStatusSnapshot(
      snap({ a: { status: "tool_running", currentTool: "Bash" } }),
    );
    const first = useStore.getState().agentStatuses.a;
    applyStatusSnapshot(
      snap({ a: { status: "tool_running", currentTool: "Edit" } }),
    );
    expect(useStore.getState().agentStatuses.a).not.toBe(first);
    expect(useStore.getState().agentStatuses.a?.currentTool).toBe("Edit");
  });

  it("stores ONLY the compared fields (wire extras like updatedAt could freeze on a reused entry)", () => {
    applyStatusSnapshot({
      a: {
        status: {
          status: "working",
          currentTool: "Bash",
          updatedAt: 1,
          lastEvent: "PreToolUse",
        },
        unread: 0,
      },
    } as unknown as AgentStatusMap);
    expect(
      Object.keys(useStore.getState().agentStatuses.a ?? {}).sort(),
    ).toEqual(["currentTool", "status", "toolDetail"]);
  });
});

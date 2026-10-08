// @vitest-environment jsdom
/**
 * Render budget: one agent's status frame must re-render only a bounded number
 * of components, however many agents the sidebar shows.
 *
 * Status frames arrive about twice per tool call per agent. Before the perf
 * work (#420/#422/#424) one frame re-rendered ~185 components at 15 agents
 * (every row's icons, every project row); memoized row bodies and structural
 * sharing cut that to the changed agent plus the row shells. This guard fails
 * CI when a change brings the fan-out back.
 *
 * Counting: a stub React DevTools hook sees every commit. A component rendered
 * this commit iff its fiber is NEW in the committed tree (React swapped in its
 * work-in-progress alternate) AND carries PerformedWork (set only when the
 * component function ran; a memo bail-out clones the fiber without it).
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commits = vi.hoisted(() => {
  // Installed before react-dom loads, which is when it registers with a hook.
  const state = { roots: [] as unknown[], last: new Set<unknown>(), count: 0 };
  // biome-ignore lint/suspicious/noExplicitAny: React's internal hook contract
  (globalThis as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    isDisabled: false,
    inject(r: unknown) {
      this.renderers.set(this.renderers.size + 1, r);
      return this.renderers.size;
    },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    // biome-ignore lint/suspicious/noExplicitAny: React fiber internals
    onCommitFiberRoot(_id: number, root: any) {
      // Function/class/forwardRef/memo component tags (React 18/19).
      const COMPONENT = new Set([0, 1, 11, 14, 15]);
      const seen = new Set<unknown>();
      let rendered = 0;
      const stack = [root.current];
      while (stack.length) {
        const f = stack.pop();
        if (!f) continue;
        if (COMPONENT.has(f.tag)) {
          seen.add(f);
          // New fiber this commit AND PerformedWork (flag 1): React clones a
          // memo'd child just to run its bail-out check, so identity alone
          // counts bailed-out components as rendered; the flag is set only
          // when the component function actually ran (react-dom 19
          // beginWork: `workInProgress.flags |= 1` after a non-bailout).
          if (!state.last.has(f) && (f.flags & 1) === 1) rendered++;
        }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
      state.last = seen;
      state.count += rendered;
    },
  };
  return state;
});

import "../test/setup-dom";
import { applyStatusSnapshot, type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

const N = 50;
// Budget for ONE agent's status frame with N agents. Measured at
// introduction: 109 (50 row shells + their Codicons + the changed agent's
// body/icon). Headroom is small on purpose; the regressions it exists for land
// far past it (measured: no memo on row bodies → 158, no memo on the provider
// icons → 306). RATCHET: lower it when a change makes the sidebar cheaper.
const RENDER_BUDGET = 115;

function sess(i: number): SessionInfo {
  const t = Date.now() - 60_000;
  return {
    id: `agent-${i}`,
    name: `agent-${i}`,
    status: "running",
    workingDirectory: `/tmp/p${i % 5}`,
    provider: "claude",
    claudeSessionId: `agent-${i}`,
    createdAt: t,
    updatedAt: t,
    lastActivityAt: t,
  } as SessionInfo;
}

const snapshot = (statusOf: (id: string) => string) =>
  Object.fromEntries(
    Array.from({ length: N }, (_, i) => [
      `agent-${i}`,
      { status: { status: statusOf(`agent-${i}`) }, unread: 0 },
    ]),
  ) as Parameters<typeof applyStatusSnapshot>[0];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]", { status: 200 }))),
  );
  const sessions = Array.from({ length: N }, (_, i) => sess(i));
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions,
    exitedSessions: [],
    agentStatuses: {},
    pinnedOrder: [],
    unpinnedOrder: sessions.map((s) => s.id),
    theme: "void",
  });
});

describe("Sidebar render budget", () => {
  it(`one agent's status frame re-renders a bounded number of components (${N} agents)`, () => {
    render(<Sidebar />);
    act(() => applyStatusSnapshot(snapshot(() => "idle")));
    // Warm frame: everything settles into the "idle" shape.
    act(() => applyStatusSnapshot(snapshot(() => "idle")));
    commits.count = 0;
    act(() =>
      applyStatusSnapshot(
        snapshot((id) => (id === "agent-7" ? "working" : "idle")),
      ),
    );
    const rendered = commits.count;
    process.stderr.write(
      `MEASURED renders for one status frame at ${N} agents: ${rendered}\n`,
    );
    expect(rendered).toBeGreaterThan(0); // precondition: the counter works
    expect(
      rendered,
      `one status frame re-rendered ${rendered} components (budget ${RENDER_BUDGET}): the sidebar's per-row fan-out came back`,
    ).toBeLessThanOrEqual(RENDER_BUDGET);
    if (rendered < RENDER_BUDGET * 0.9)
      process.stderr.write(
        `RATCHET: ${rendered} renders is well under the budget of ${RENDER_BUDGET}; lower RENDER_BUDGET to lock the win in.\n`,
      );
  });
});

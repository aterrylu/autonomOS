// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test/setup-dom";
import type { ProjectInfo } from "@autonomos/core";
import { changeAwareStorage } from "./persistStorage";
import { applyProjectsSnapshot, useStore } from "./store";

/**
 * persist writes through the REAL store + zustand middleware: count the actual
 * localStorage.setItem calls. The default storage wrote the whole persisted
 * slice on EVERY update; the change-aware storage writes only when a persisted
 * field changed.
 */

const KEY = "autonomos";
let writes = 0;
let setItemSpy: ReturnType<typeof vi.spyOn>;

const project = (id: string): ProjectInfo =>
  ({
    id,
    name: id,
    path: `/tmp/${id}`,
    sessions: [],
  }) as unknown as ProjectInfo;

beforeEach(() => {
  localStorage.clear();
  // Prime the storage's reference tracking with the current persisted fields
  // (the write itself may be skipped if its JSON equals the previous test's).
  useStore.setState({
    theme: "void",
    projects: [project("a")],
    sidebarWidth: 280,
  });
  writes = 0;
  // setup-dom installs a plain-object localStorage shim (not a Storage
  // instance), so spy on the object itself. The storage adapter looks up
  // `setItem` at call time, so the spy sees every write.
  const realSetItem = localStorage.setItem.bind(localStorage);
  setItemSpy = vi
    .spyOn(localStorage, "setItem")
    .mockImplementation((key: string, value: string) => {
      if (key === KEY) writes += 1;
      return realSetItem(key, value);
    });
});
afterEach(() => setItemSpy.mockRestore());

describe("persist writes only when persisted state changes", () => {
  it("non-persisted updates (status frames) never write", () => {
    for (let i = 0; i < 50; i++) {
      useStore.setState({
        agentStatuses: { [`id-${i}`]: { status: "working" } } as never,
        notificationCounts: { [`id-${i}`]: i },
      });
    }
    expect(writes).toBe(0);
  });

  it("non-persisted updates don't even SERIALIZE the persisted slice (the ~24KB stringify)", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (let i = 0; i < 50; i++) {
        useStore.setState({ notificationCounts: { [`id-${i}`]: i } });
      }
      const persistSerializations = stringify.mock.calls.filter(
        ([v]) =>
          typeof v === "object" && v !== null && "state" in v && "version" in v,
      ).length;
      expect(persistSerializations).toBe(0);
    } finally {
      stringify.mockRestore();
    }
  });

  it("a persisted field change writes exactly once", () => {
    useStore.setState({ theme: "daylight" as never });
    expect(writes).toBe(1);
  });

  it("the projects poll re-delivering equal content as a new array does not write", () => {
    applyProjectsSnapshot([project("a")]); // new array, same JSON
    applyProjectsSnapshot([project("a")]);
    expect(writes).toBe(0);
    applyProjectsSnapshot([project("a"), project("b")]); // real change
    expect(writes).toBe(1);
  });

  it("each persisted change still writes (sidebar width)", () => {
    for (const w of [281, 282, 283]) useStore.getState().setSidebarWidth(w);
    expect(writes).toBe(3);
  });
});

describe("changeAwareStorage", () => {
  it("returns undefined without usable storage (persist then skips, like the default)", () => {
    expect(
      changeAwareStorage(() => {
        throw new Error("no window");
      }),
    ).toBeUndefined();
    expect(changeAwareStorage(() => ({}) as Storage)).toBeUndefined();
  });

  it("a failed write (quota) is logged once, not thrown; the next update retries", () => {
    let fail = true;
    const store: Record<string, string> = {};
    const storage = changeAwareStorage<{ n: number }>(() => ({
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        if (fail) throw new Error("QuotaExceededError");
        store[k] = v;
      },
      removeItem: (k) => {
        delete store[k];
      },
    }));
    const value = { state: { n: 1 }, version: 0 };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Best-effort: must not throw out of the caller's set().
      expect(() => storage?.setItem("k", value)).not.toThrow();
      expect(() => storage?.setItem("k", value)).not.toThrow();
      expect(errorLog).toHaveBeenCalledTimes(1); // once, not per update
    } finally {
      errorLog.mockRestore();
    }
    fail = false;
    storage?.setItem("k", value); // same state: must NOT be skipped as unchanged
    expect(JSON.parse(store.k)).toEqual(value);
  });

  it("clearStorage resets the tracking: the next update writes even if nothing persisted changed", () => {
    useStore.persist.clearStorage();
    useStore.setState({ notificationCounts: { x: 1 } }); // non-persisted
    expect(writes).toBe(1);
  });

  it("a write after rehydrate() is not skipped against stale tracking", async () => {
    // Make this tab's LAST actual write the "void" JSON.
    useStore.setState({ theme: "daylight" as never });
    useStore.setState({ theme: "void" });
    const voidJson = localStorage.getItem(KEY) ?? "";
    expect(JSON.parse(voidJson).state.theme).toBe("void");
    // Another writer changes storage; this tab re-reads it.
    const raw = JSON.parse(voidJson);
    raw.state.theme = "daylight";
    localStorage.setItem(KEY, JSON.stringify(raw));
    await useStore.persist.rehydrate();
    expect(useStore.getState().theme).toBe("daylight");
    writes = 0;
    // Back to "void": its JSON equals this tab's last write. Without the reset
    // on read, the write would be skipped and storage would keep "daylight".
    useStore.setState({ theme: "void" });
    expect(writes).toBe(1);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").state.theme).toBe(
      "void",
    );
  });
});

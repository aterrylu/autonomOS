// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPoll } from "./poll";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createPoll", () => {
  it("starts on first subscribe, stops on last unsubscribe (shared timer)", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const poll = createPoll({ source: fetcher, intervalMs: 1000 });
    const un1 = poll.subscribe(() => {});
    const un2 = poll.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0); // initial refresh
    expect(fetcher).toHaveBeenCalledTimes(1); // shared — not one per subscriber
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    un1();
    un2();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(3); // stopped
  });

  it("pauses while hidden and refreshes immediately on return", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const poll = createPoll({ source: fetcher, intervalMs: 1000 });
    const un = poll.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1); // backgrounded tab costs nothing

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2); // immediate catch-up refresh
    un();
  });

  it("keeps last data on a failed refresh and surfaces the error beside it", async () => {
    let fail = false;
    const fetcher = vi.fn(async () => {
      if (fail) throw new Error("boom");
      return { v: 1 };
    });
    const poll = createPoll({ source: fetcher, intervalMs: 1000 });
    const un = poll.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(poll.getSnapshot()).toEqual({ data: { v: 1 }, error: null });

    fail = true;
    await vi.advanceTimersByTimeAsync(1000);
    const s = poll.getSnapshot();
    expect(s.data).toEqual({ v: 1 }); // stale is shown, not blanked
    expect(s.error?.message).toBe("boom"); // ...and marked
    un();
  });

  it("keeps reference equality when data is unchanged (no render churn)", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const poll = createPoll({ source: fetcher, intervalMs: 1000 });
    const listener = vi.fn();
    const un = poll.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    const first = poll.getSnapshot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll.getSnapshot()).toBe(first); // identical payloads → same snapshot
    expect(listener).toHaveBeenCalledTimes(1); // only the initial commit
    un();
  });
});

describe("hiddenIntervalMs (background-critical polls)", () => {
  it("throttles instead of pausing while hidden — desktop notifications keep flowing", async () => {
    const fetcher = vi.fn(async () => ({ v: 1 }));
    const poll = createPoll({
      source: fetcher,
      intervalMs: 1000,
      hiddenIntervalMs: 5000,
    });
    const un = poll.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    // 10s hidden at a 5s hidden cadence ≈ 2 refreshes — throttled, not dead
    // (a paused default poll would sit at 1) and not full-rate (would be 11).
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2000);
    // Foreground cadence resumes at full rate immediately.
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(5);
    un();
  });
});

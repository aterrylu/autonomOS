// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { NOW_TICK_MS, useNow } from "./useNow";

/** useNow — the shared coarse clock behind relative-time labels. */

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
};

function Probe({ onValue }: { onValue: (n: number) => void }) {
  const now = useNow();
  onValue(now);
  return <span>{now}</span>;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useNow", () => {
  it("many subscribers share ONE interval", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const { unmount } = render(
      <>
        <Probe onValue={() => {}} />
        <Probe onValue={() => {}} />
        <Probe onValue={() => {}} />
      </>,
    );
    expect(setInterval).toHaveBeenCalledTimes(1);
    unmount();
    setInterval.mockRestore();
  });

  it("re-renders subscribers with the new time every tick", () => {
    const seen: number[] = [];
    const { unmount } = render(<Probe onValue={(n) => seen.push(n)} />);
    const first = seen.at(-1) ?? 0;
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });
    expect((seen.at(-1) ?? 0) - first).toBe(NOW_TICK_MS);
    unmount();
  });

  it("the snapshot is stable between ticks (a parent re-render doesn't change it)", () => {
    const seen: number[] = [];
    const { rerender, unmount } = render(
      <Probe onValue={(n) => seen.push(n)} />,
    );
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS - 1);
    });
    rerender(<Probe onValue={(n) => seen.push(n)} />);
    expect(new Set(seen).size).toBe(1);
    unmount();
  });

  it("pauses while hidden and ticks immediately on becoming visible", () => {
    const seen: number[] = [];
    const { unmount } = render(<Probe onValue={(n) => seen.push(n)} />);
    act(() => setVisibility("hidden"));
    const whileHidden = seen.at(-1);
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS * 3);
    });
    expect(seen.at(-1)).toBe(whileHidden); // no ticks in the background
    act(() => setVisibility("visible"));
    expect(seen.at(-1)).toBe(Date.now()); // current the moment you look
    unmount();
  });

  it("clears its interval when the last subscriber unmounts", () => {
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<Probe onValue={() => {}} />);
    unmount();
    expect(clearInterval).toHaveBeenCalled();
    clearInterval.mockRestore();
  });

  it("mounting while HIDDEN starts no ticking until the tab is visible", () => {
    visibility = "hidden";
    const seen: number[] = [];
    const { unmount } = render(<Probe onValue={(n) => seen.push(n)} />);
    const atMount = seen.at(-1);
    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS * 3);
    });
    expect(seen.at(-1)).toBe(atMount);
    unmount();
  });

  it("a duplicate 'visible' event does not stack a second interval", () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const { unmount } = render(<Probe onValue={() => {}} />);
    act(() => setVisibility("visible"));
    act(() => setVisibility("visible"));
    expect(setInterval).toHaveBeenCalledTimes(1);
    unmount();
    setInterval.mockRestore();
  });
});

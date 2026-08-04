// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { isMac } from "../utils/platform";
import { MOD_HOLD_DELAY_MS, useModKeyHold } from "./useModKeyHold";

const MOD_KEY = isMac ? "Meta" : "Control";
const modDown = (repeat = false) =>
  new KeyboardEvent("keydown", {
    key: MOD_KEY,
    [isMac ? "metaKey" : "ctrlKey"]: true,
    repeat,
  } as KeyboardEventInit);
const modUp = () => new KeyboardEvent("keyup", { key: MOD_KEY });

function held() {
  return useStore.getState().modKeyHeld;
}

describe("useModKeyHold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ modKeyHeld: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    useStore.setState({ modKeyHeld: false });
  });

  it("arms after the hold delay, not on a quick tap", () => {
    const { unmount } = renderHook(() => useModKeyHold(true));
    window.dispatchEvent(modDown());
    expect(held()).toBe(false);
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS - 1);
    expect(held()).toBe(false); // a fast ⌘C never flashes badges
    vi.advanceTimersByTime(1);
    expect(held()).toBe(true);
    unmount();
  });

  it("auto-repeat keydowns do not restart the timer", () => {
    const { unmount } = renderHook(() => useModKeyHold(true));
    window.dispatchEvent(modDown());
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS / 2);
    window.dispatchEvent(modDown(true)); // OS auto-repeat mid-wait
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS / 2);
    expect(held()).toBe(true); // fired at the ORIGINAL deadline
    unmount();
  });

  it("keyup clears; a pending timer is cancelled", () => {
    const { unmount } = renderHook(() => useModKeyHold(true));
    window.dispatchEvent(modDown());
    window.dispatchEvent(modUp()); // released before the delay
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS * 2);
    expect(held()).toBe(false);

    window.dispatchEvent(modDown());
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS);
    expect(held()).toBe(true);
    window.dispatchEvent(modUp());
    expect(held()).toBe(false);
    unmount();
  });

  it("window blur clears (⌘Tab away eats the keyup — the stuck-badge case)", () => {
    const { unmount } = renderHook(() => useModKeyHold(true));
    window.dispatchEvent(modDown());
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS);
    expect(held()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(held()).toBe(false);
    unmount();
  });

  it("a chord WITH the modifier keeps badges up; a bare key without it clears", () => {
    const { unmount } = renderHook(() => useModKeyHold(true));
    window.dispatchEvent(modDown());
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS);
    expect(held()).toBe(true);

    // mod+1 while holding — user is walking panes; badges stay.
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "1",
        code: "Digit1",
        [isMac ? "metaKey" : "ctrlKey"]: true,
      } as KeyboardEventInit),
    );
    expect(held()).toBe(true);

    // A bare keydown with NO modifier means we missed the release.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(held()).toBe(false);
    unmount();
  });

  it("disabled (login screen) and unmount both leave no state behind", () => {
    const a = renderHook(() => useModKeyHold(false));
    window.dispatchEvent(modDown());
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS);
    expect(held()).toBe(false);
    a.unmount();

    const b = renderHook(() => useModKeyHold(true));
    window.dispatchEvent(modDown());
    vi.advanceTimersByTime(MOD_HOLD_DELAY_MS);
    expect(held()).toBe(true);
    b.unmount(); // cleanup clears the flag
    expect(held()).toBe(false);
  });
});

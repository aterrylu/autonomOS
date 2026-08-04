import { describe, expect, it, vi } from "vitest";
import {
  closeTopEscape,
  hasEscapeCloser,
  pushEscapeCloser,
} from "./escapeStack";

describe("escapeStack", () => {
  it("is LIFO: Escape closes the most recently opened thing first", () => {
    const first = vi.fn();
    const second = vi.fn();
    const popFirst = pushEscapeCloser(first);
    const popSecond = pushEscapeCloser(second);

    closeTopEscape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    // A real closer unmounts its owner, which pops the registration.
    popSecond();
    closeTopEscape();
    expect(first).toHaveBeenCalledTimes(1);
    popFirst();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("cleanup is idempotent and removes exactly its own registration", () => {
    const close = vi.fn();
    const popA = pushEscapeCloser(close);
    const popB = pushEscapeCloser(close); // same callback registered twice

    popA();
    popA(); // double-call must not remove B's registration
    expect(hasEscapeCloser()).toBe(true);
    popB();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("out-of-order cleanup removes the right entry", () => {
    const bottom = vi.fn();
    const top = vi.fn();
    const popBottom = pushEscapeCloser(bottom);
    const popTop = pushEscapeCloser(top);

    popBottom(); // bottom closes first (e.g. its panel unmounted underneath)
    closeTopEscape();
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
    popTop();
  });

  it("a throwing closer forfeits its slot (Escape must not stay reserved for a broken panel)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn();
    const popHealthy = pushEscapeCloser(healthy);
    const popBroken = pushEscapeCloser(() => {
      throw new Error("broken closer");
    });

    closeTopEscape(); // broken closer throws → force-popped
    expect(err).toHaveBeenCalled();
    closeTopEscape(); // next Escape reaches the healthy one underneath
    expect(healthy).toHaveBeenCalledTimes(1);

    popBroken(); // owner cleanup later — must be a safe no-op
    popHealthy();
    expect(hasEscapeCloser()).toBe(false);
    err.mockRestore();
  });

  it("closeTopEscape on an empty stack is a safe no-op", () => {
    expect(hasEscapeCloser()).toBe(false);
    expect(() => closeTopEscape()).not.toThrow();
  });
});

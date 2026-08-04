// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import "../../test/setup-dom";
import { closeTopEscape, hasEscapeCloser } from "../../shortcuts/escapeStack";
import { useClickOutside } from "./useClickOutside";

/**
 * The Escape half of useClickOutside rides the registry's escape stack
 * (ADR-065). These tests pin the registration lifecycle — the old document
 * keydown listener was silently dead whenever a terminal had focus, and
 * nothing failed when it was.
 */

function mountPopover(onClose: () => void) {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(null);
    useClickOutside(ref, onClose);
  });
}

describe("useClickOutside escape registration", () => {
  it("registers a dismissal while mounted and releases it on unmount", () => {
    expect(hasEscapeCloser()).toBe(false);
    const onClose = vi.fn();
    const { unmount } = mountPopover(onClose);

    expect(hasEscapeCloser()).toBe(true);
    closeTopEscape();
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("two open popovers dismiss LIFO", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = mountPopover(first);
    const b = mountPopover(second);

    closeTopEscape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    b.unmount();
    closeTopEscape();
    expect(first).toHaveBeenCalledTimes(1);
    a.unmount();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("onClose identity churn calls the LATEST closer without re-registering", () => {
    const closes: Array<() => void> = [vi.fn(), vi.fn()];
    let which = 0;
    const { rerender, unmount } = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null);
      useClickOutside(ref, closes[which] as () => void);
    });
    which = 1;
    rerender();

    closeTopEscape();
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(closes[0]).not.toHaveBeenCalled();
    unmount();
    expect(hasEscapeCloser()).toBe(false);
  });

  it("identity churn on a BOTTOM popover must not steal the top of the stack", () => {
    // The reorder bug this pins: open popover A, then modal B on top of it.
    // A's owner re-renders (new inline onClose identity). If churn re-pushed,
    // A would move above B and Escape would close the panel hidden BEHIND the
    // modal. The mount-scoped registration + latest-closer ref prevents it.
    const closeA = vi.fn();
    const closeB = vi.fn();
    let aIdentity = 0;
    const a = renderHook(() => {
      const ref = useRef<HTMLElement | null>(null);
      // new arrow identity every render, like every real call site
      aIdentity += 0;
      useClickOutside(ref, () => closeA());
    });
    const b = mountPopover(closeB);

    a.rerender(); // unrelated re-render of the BOTTOM popover's owner

    closeTopEscape();
    expect(closeB).toHaveBeenCalledTimes(1); // top stays top
    expect(closeA).not.toHaveBeenCalled();
    b.unmount();
    a.unmount();
    expect(hasEscapeCloser()).toBe(false);
  });
});

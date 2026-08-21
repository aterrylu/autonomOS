// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";

// The overlay is exercised through its real consumer so the wiring (handle →
// hook → container style) is covered end to end. Only the data hook is mocked,
// pinned to capped:true so the overlay renders.
vi.mock("./useUsageQueue", () => ({ useUsageQueue: vi.fn() }));

import { UsageQueueButton } from "../components/UsageQueueButton";
import { useUsageQueue } from "./useUsageQueue";

const mockHook = vi.mocked(useUsageQueue);

/**
 * jsdom computes no layout: `offsetParent` is null and every `offset*`/`client*`
 * is 0, which would make the clamp math vacuous. We stub geometry on
 * HTMLElement.prototype so the overlay reports a real pane + size, and install a
 * controllable ResizeObserver so a "pane resized" event can be fired on demand.
 */
const PARENT = { clientWidth: 800, clientHeight: 600 };
const OVERLAY_W = 292; // 22 handle + 270 content
const OVERLAY_H = 44;
const START_LEFT = 100;
const START_TOP = 100;
// Clamp bounds for the constants above: x∈[12,496], y∈[12,544].
const MAX_X = PARENT.clientWidth - OVERLAY_W - 12; // 496
const MAX_Y = PARENT.clientHeight - OVERLAY_H - 12; // 544

// Controllable offsetParent: null simulates a display:none (hidden) pane, whose
// descendants have a null offsetParent; flip to PARENT to simulate the pane
// becoming visible. parentElement stays the real rendered node throughout.
let offsetParentVal: unknown = PARENT;
let roCallback: (() => void) | null = null;
const saved: Array<[string, PropertyDescriptor | undefined]> = [];

function stubProto(prop: string, getter: () => unknown) {
  saved.push([
    prop,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop),
  ]);
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get: getter,
  });
}

beforeEach(() => {
  mockHook.mockReset();
  mockHook.mockReturnValue({
    isArmed: false,
    capped: true,
    resetsAt: null,
    capWindow: null,
    toggle: vi.fn(async () => {}),
  });
  localStorage.clear();
  PARENT.clientWidth = 800;
  PARENT.clientHeight = 600;
  offsetParentVal = PARENT;
  stubProto("offsetParent", () => offsetParentVal);
  stubProto("offsetWidth", () => OVERLAY_W);
  stubProto("offsetHeight", () => OVERLAY_H);
  stubProto("offsetLeft", () => START_LEFT);
  stubProto("offsetTop", () => START_TOP);
  roCallback = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  for (const [prop, desc] of saved.splice(0)) {
    if (desc) Object.defineProperty(HTMLElement.prototype, prop, desc);
    else delete (HTMLElement.prototype as Record<string, unknown>)[prop];
  }
  vi.unstubAllGlobals();
});

const KEY = "usageQueueOverlayPos:s1";
const overlay = () => screen.getByTestId("usage-queue-overlay");
const handle = () => screen.getByTestId("usage-queue-drag-handle");

// jsdom's fireEvent.pointer* does not populate clientX/clientY (PointerEvent is
// only partially implemented), which makes the drag math NaN. A MouseEvent DOES
// carry clientX/clientY natively, and dispatching it under the pointer* type
// still triggers React's onPointer* handlers. act() flushes the state update.
function pointer(type: string, clientX: number, clientY: number) {
  const el = handle();
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  act(() => {
    el.dispatchEvent(ev);
  });
}

function drag(fromX: number, fromY: number, toX: number, toY: number) {
  pointer("pointerdown", fromX, fromY);
  pointer("pointermove", toX, toY);
  pointer("pointerup", toX, toY);
}

describe("draggable usage-queue overlay", () => {
  it("defaults to the pane's TOP-RIGHT (clear of the bottom input line)", () => {
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    const el = overlay();
    // Never-dragged → CSS corner, not a left/top position.
    expect(el.style.top).toBe("12px");
    expect(el.style.right).toBe("12px");
    expect(el.style.left).toBe("");
  });

  it("drags by the handle and follows the pointer delta", () => {
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    // start (100,100) → pointer +50,+30 → (150,130), inside bounds.
    drag(200, 200, 250, 230);
    expect(overlay().style.left).toBe("150px");
    expect(overlay().style.top).toBe("130px");
    expect(overlay().style.right).toBe(""); // switched off the corner default
  });

  it("clamps inside the pane so it can't be dragged off-canvas", () => {
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    // Yank far past the bottom-right corner.
    drag(200, 200, 5000, 5000);
    expect(overlay().style.left).toBe(`${MAX_X}px`);
    expect(overlay().style.top).toBe(`${MAX_Y}px`);
  });

  it("persists position PER TERMINAL and restores it on re-mount", () => {
    const { unmount } = render(
      <UsageQueueButton sessionId="s1" provider="codex" />,
    );
    drag(200, 200, 260, 240); // → (160,140)
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({
      x: 160,
      y: 140,
    });
    unmount();
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    expect(overlay().style.left).toBe("160px");
    expect(overlay().style.top).toBe("140px");
  });

  it("does not restore another terminal's saved position", () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 300, y: 200 }));
    // A different session id must ignore s1's saved position.
    render(<UsageQueueButton sessionId="s2" provider="codex" />);
    expect(overlay().style.left).toBe(""); // s2 uses the default corner
    expect(overlay().style.right).toBe("12px");
  });

  it("re-clamps on pane resize so a shrunk pane can't strand it off-canvas", () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 400, y: 400 }));
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    expect(overlay().style.left).toBe("400px");
    // Pane shrinks so (400,400) is now out of bounds but the overlay still fits
    // → re-clamp to the new max corner (350-292-12=46, 300-44-12=244).
    PARENT.clientWidth = 350;
    PARENT.clientHeight = 300;
    act(() => {
      roCallback?.();
    });
    expect(overlay().style.left).toBe("46px");
    expect(overlay().style.top).toBe("244px");
  });

  it("wires the resize re-clamp on the REAL path — overlay hidden (uncapped) then appears", () => {
    // Production path: a pane is not at its cap on mount, so the overlay renders
    // null first and only appears LATER. A one-shot mount effect would wire the
    // observer against a null ref and never re-run — leaving re-clamp dead.
    localStorage.setItem(KEY, JSON.stringify({ x: 400, y: 400 }));
    mockHook.mockReturnValue({
      isArmed: false,
      capped: false,
      resetsAt: null,
      capWindow: null,
      toggle: vi.fn(async () => {}),
    });
    const { rerender } = render(
      <UsageQueueButton sessionId="s1" provider="codex" />,
    );
    expect(screen.queryByTestId("usage-queue-overlay")).toBeNull();

    // Hits the cap → the overlay mounts now.
    mockHook.mockReturnValue({
      isArmed: false,
      capped: true,
      resetsAt: null,
      capWindow: null,
      toggle: vi.fn(async () => {}),
    });
    rerender(<UsageQueueButton sessionId="s1" provider="codex" />);
    expect(overlay().style.left).toBe("400px");

    // Pane shrinks → re-clamp MUST fire despite the late mount.
    PARENT.clientWidth = 350;
    PARENT.clientHeight = 300;
    act(() => {
      roCallback?.();
    });
    expect(overlay().style.left).toBe("46px");
    expect(overlay().style.top).toBe("244px");
  });

  it("clamps a restored position on mount when the pane is now smaller (no resize event)", () => {
    // Saved far out (e.g. a wide pane last session); restored into an 800×600
    // pane it must be pulled in on mount, not left stranded until a resize fires.
    localStorage.setItem(KEY, JSON.stringify({ x: 700, y: 500 }));
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    // maxX = 800-292-12 = 496 → x pulled 700→496; y=500 already inside 544.
    expect(overlay().style.left).toBe("496px");
    expect(overlay().style.top).toBe("500px");
  });

  it("nudges with arrow keys (keyboard a11y) and persists", () => {
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    handle().focus();
    // From the stubbed start (100,100): ArrowRight → +12 x.
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(overlay().style.left).toBe("112px");
    expect(overlay().style.top).toBe("100px");
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({
      x: 112,
      y: 100,
    });
  });

  it("focuses the handle on pointer-down so arrow-key nudge works right after a drag", () => {
    // preventDefault on the handle suppresses implicit focus; the hook restores
    // it explicitly, else keyboard nudge would need a Tab first.
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    pointer("pointerdown", 200, 200);
    expect(document.activeElement).toBe(handle());
    pointer("pointerup", 200, 200);
  });

  it("clamps a background (display:none) pane's overlay once it becomes visible", () => {
    // A provider-wide cap flips ALL that provider's panes capped at once, so a
    // background pane's overlay mounts inside a display:none subtree — offsetParent
    // is null, so clamp-on-mount is a no-op. The observer is keyed on
    // parentElement (non-null while hidden), so it fires when the pane gets a real
    // box on becoming visible, and THEN the clamp runs.
    localStorage.setItem(KEY, JSON.stringify({ x: 700, y: 400 }));
    offsetParentVal = null; // hidden pane
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    expect(overlay().style.left).toBe("700px"); // not clamped while hidden

    offsetParentVal = PARENT; // pane becomes visible → 0×0 → real box
    act(() => {
      roCallback?.();
    });
    expect(overlay().style.left).toBe("496px"); // now pulled in-bounds (maxX)
    expect(overlay().style.top).toBe("400px"); // y=400 already inside 544
  });

  it("clears the drag session on pointercancel so a later hover doesn't chase the cursor", () => {
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    pointer("pointerdown", 200, 200);
    pointer("pointermove", 260, 240); // → (160,140)
    expect(overlay().style.left).toBe("160px");

    pointer("pointercancel", 260, 240);
    // A bare move afterwards (no active drag) must NOT move the overlay.
    pointer("pointermove", 500, 500);
    expect(overlay().style.left).toBe("160px"); // unchanged — session cleared
  });

  it("keeps the arm toggle working (drag handle is separate from the switch)", () => {
    const toggle = vi.fn(async () => {});
    mockHook.mockReturnValue({
      isArmed: false,
      capped: true,
      resetsAt: null,
      capWindow: null,
      toggle,
    });
    render(<UsageQueueButton sessionId="s1" provider="codex" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

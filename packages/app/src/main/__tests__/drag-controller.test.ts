import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DragController,
  type DraggableWindow,
  type Point,
} from "../drag-controller.js";

/**
 * The drag controller's job is twofold and both halves are leak-prone:
 *   1. reposition the window to preserve the cursor↔corner offset each frame
 *   2. NEVER leak a setInterval — restart, end, destroyed-window, and quit
 *      must all clear timers
 * Electron's `screen` + `setInterval` are injected, so a test can step frames
 * deterministically and count live timers.
 */

interface FakeTimer {
  fn: () => void;
  cleared: boolean;
}

/** A test harness: controllable cursor + a fake timer registry. */
function harness() {
  const timers = new Set<FakeTimer>();
  let cursor: Point = { x: 0, y: 0 };
  const controller = new DragController({
    getCursor: () => cursor,
    setInterval: (fn) => {
      const t: FakeTimer = { fn, cleared: false };
      timers.add(t);
      return t;
    },
    clearInterval: (h) => {
      const t = h as FakeTimer;
      t.cleared = true;
      timers.delete(t);
    },
  });
  return {
    controller,
    setCursor: (p: Point) => {
      cursor = p;
    },
    liveTimers: () => timers.size,
    tickAll: () => {
      for (const t of [...timers]) t.fn();
    },
  };
}

function fakeWindow(
  id: number,
  pos: [number, number],
): DraggableWindow & {
  setTo: number[];
  destroyed: boolean;
} {
  const w = {
    id,
    setTo: [...pos] as number[],
    destroyed: false,
    getPosition: () => pos,
    setPosition(x: number, y: number) {
      w.setTo = [x, y];
    },
    isDestroyed: () => w.destroyed,
  };
  return w;
}

describe("DragController", () => {
  it("repositions the window preserving the cursor↔corner offset", () => {
    const h = harness();
    h.setCursor({ x: 150, y: 220 }); // window at (100,200) ⇒ offset (50,20)
    const win = fakeWindow(1, [100, 200]);

    h.controller.start(win);
    assert.equal(h.liveTimers(), 1);

    // Move cursor to (300, 400); window should follow to (250, 380).
    h.setCursor({ x: 300, y: 400 });
    h.tickAll();
    assert.deepEqual(win.setTo, [250, 380]);
  });

  it("restarting a drag for the same window does not leak the prior timer", () => {
    const h = harness();
    const win = fakeWindow(7, [0, 0]);
    h.controller.start(win);
    h.controller.start(win); // restart
    assert.equal(h.liveTimers(), 1, "only one live timer after restart");
    assert.equal(h.controller.activeCount(), 1);
  });

  it("end() clears the timer and forgets the window", () => {
    const h = harness();
    const win = fakeWindow(3, [10, 10]);
    h.controller.start(win);
    h.controller.end(3);
    assert.equal(h.liveTimers(), 0);
    assert.equal(h.controller.activeCount(), 0);
  });

  it("end() on an unknown id is a no-op", () => {
    const h = harness();
    assert.doesNotThrow(() => h.controller.end(999));
    assert.equal(h.liveTimers(), 0);
  });

  it("a destroyed window ends its own drag on the next frame", () => {
    const h = harness();
    const win = fakeWindow(5, [0, 0]);
    h.controller.start(win);
    win.destroyed = true;
    h.tickAll(); // frame sees isDestroyed() ⇒ self-end
    assert.equal(h.liveTimers(), 0, "destroyed window must not leak its timer");
    assert.equal(h.controller.activeCount(), 0);
  });

  it("cleanupAll clears every active drag's timer", () => {
    const h = harness();
    h.controller.start(fakeWindow(1, [0, 0]));
    h.controller.start(fakeWindow(2, [0, 0]));
    h.controller.start(fakeWindow(3, [0, 0]));
    assert.equal(h.liveTimers(), 3);
    h.controller.cleanupAll();
    assert.equal(h.liveTimers(), 0);
    assert.equal(h.controller.activeCount(), 0);
  });

  it("tracks multiple independent windows without cross-talk", () => {
    const h = harness();
    h.setCursor({ x: 100, y: 100 });
    const a = fakeWindow(1, [90, 90]); // offset (10,10)
    const b = fakeWindow(2, [50, 50]); // offset (50,50)
    h.controller.start(a);
    h.controller.start(b);
    h.setCursor({ x: 200, y: 200 });
    h.tickAll();
    assert.deepEqual(a.setTo, [190, 190]);
    assert.deepEqual(b.setTo, [150, 150]);
  });
});

// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";

/**
 * The terminal-reload nonce (store.reloadTerminal, bumped by restartSession)
 * must make useTerminal's attach effect DROP the current terminal and re-acquire
 * a fresh one — the deterministic fix for "restart while already focused leaves a
 * dead terminal." A fresh mount / switch-back must NOT dispose (ADR-072 keep-alive
 * reuse). We mock liveTerminals and assert acquire/dispose call patterns.
 */
// vi.mock is hoisted above imports, so the mocks it references must be built in
// vi.hoisted (which runs first) rather than as plain top-level consts.
const { acquireTerminal, disposeTerminal, getLiveTerminal, focusTerminal } =
  vi.hoisted(() => {
    const fakeEntry = () => ({
      attach: vi.fn(),
      detach: vi.fn(),
      bindFollowIndicator: vi.fn(),
      jumpToLatest: vi.fn(),
      terminal: { focus: vi.fn(), options: {} },
    });
    return {
      acquireTerminal: vi.fn(() => fakeEntry()),
      disposeTerminal: vi.fn(),
      getLiveTerminal: vi.fn(() => fakeEntry()),
      // The reconnect-focus goes through focusTerminal (which polls until the
      // xterm textarea is visible before focusing — the real-browser fix). The
      // dom test verifies the WIRING; the actual focus lands in a real browser.
      focusTerminal: vi.fn(),
    };
  });

vi.mock("../terminal/liveTerminals", () => ({
  acquireTerminal,
  disposeTerminal,
  getLiveTerminal,
  focusTerminal,
  handleKeyEvent: vi.fn(),
}));

import { useStore } from "../store";
import { useTerminal } from "./useTerminal";

function Harness({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useTerminal(ref, id);
  return <div ref={ref} data-testid="host" />;
}

beforeEach(() => {
  useStore.setState({
    terminalReloadNonce: {},
    // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
  } as any);
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe("useTerminal — terminal-reload nonce", () => {
  it("acquires once on mount and does NOT dispose (first mount is not a reload)", () => {
    render(<Harness id="a1" />);
    expect(acquireTerminal).toHaveBeenCalledWith("a1");
    expect(acquireTerminal).toHaveBeenCalledTimes(1);
    expect(disposeTerminal).not.toHaveBeenCalled();
  });

  it("bumping the nonce WHILE MOUNTED disposes the stale terminal and re-acquires", () => {
    render(<Harness id="a1" />);
    acquireTerminal.mockClear();
    act(() => {
      useStore.getState().reloadTerminal("a1");
    });
    // The dead terminal is force-dropped (closing the 4010 race) then a fresh one
    // is acquired — the pane reconnects to the restarted PTY.
    expect(disposeTerminal).toHaveBeenCalledWith("a1");
    expect(acquireTerminal).toHaveBeenCalledWith("a1");
  });

  it("a bump for a DIFFERENT session does not disturb this pane", () => {
    render(<Harness id="a1" />);
    acquireTerminal.mockClear();
    act(() => {
      useStore.getState().reloadTerminal("other");
    });
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(acquireTerminal).not.toHaveBeenCalled();
  });

  it("a fresh mount after a prior bump reuses the cache (no dispose) — keep-alive intact", () => {
    // Simulate the nonce already bumped (e.g. restart-from-elsewhere) BEFORE mount.
    act(() => {
      useStore.getState().reloadTerminal("a1");
    });
    vi.clearAllMocks();
    render(<Harness id="a1" />); // fresh mount sees the current nonce as its baseline
    expect(disposeTerminal).not.toHaveBeenCalled();
    expect(acquireTerminal).toHaveBeenCalledTimes(1);
  });

  it("re-focuses the reconnected terminal when its pane WAS active (Terry's re-test)", () => {
    // The restarted pane is the focused one.
    useStore.setState({
      activePane: { type: "session", id: "a1" },
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
    render(<Harness id="a1" />);
    focusTerminal.mockClear();
    act(() => {
      useStore.getState().reloadTerminal("a1");
    });
    // Goes through focusTerminal, which polls until the fresh xterm textarea is
    // visible before focusing (the real-browser fix). Without the reloadNonce dep
    // the effect never re-fires, so the reconnected pane keeps no keyboard focus.
    expect(focusTerminal).toHaveBeenCalledWith("a1");
  });

  it("does NOT steal focus on a reload of a NON-active pane", () => {
    useStore.setState({
      activePane: { type: "session", id: "someone-else" },
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
    render(<Harness id="a1" />);
    focusTerminal.mockClear();
    act(() => {
      useStore.getState().reloadTerminal("a1");
    });
    expect(focusTerminal).not.toHaveBeenCalled();
  });
});

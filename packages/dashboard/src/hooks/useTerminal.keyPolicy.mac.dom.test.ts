// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import type { TerminalInstance } from "../terminal/types";

/**
 * Terminal key policy, MAC half. `isMac` is a module-load constant computed
 * from navigator, so the mac branch is unreachable in a stock jsdom run —
 * mock the platform module instead. The mock applies to the WHOLE import
 * graph of this file (registry + chord included), so `mod` is consistently ⌘
 * everywhere, exactly like a real mac browser.
 */
vi.mock("../utils/platform", () => ({
  isMac: true,
  hasPrimaryModifier: (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey,
}));

import { handleKeyEvent } from "./useTerminal";

function fakeTerminal() {
  return { clear: vi.fn(), selectAll: vi.fn() } as unknown as TerminalInstance;
}

function wsRef() {
  return {
    current: { readyState: WebSocket.OPEN, send: vi.fn() },
  } as unknown as React.RefObject<WebSocket | null>;
}

function key(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", init);
}

describe("handleKeyEvent — mac (mod = ⌘, plain Ctrl belongs to the shell)", () => {
  it("Ctrl+D reaches the shell — EOF restored (ADR-065)", () => {
    expect(
      handleKeyEvent(key({ key: "d", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(true);
  });

  it("Ctrl+W reaches the shell — delete-word restored (ADR-065)", () => {
    expect(
      handleKeyEvent(key({ key: "w", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(true);
  });

  it("Ctrl+B reaches the shell — tmux prefix / readline back-char restored (ADR-065)", () => {
    expect(
      handleKeyEvent(key({ key: "b", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(true);
  });

  it("⌘B is declined (registry sidebar chord)", () => {
    expect(
      handleKeyEvent(key({ key: "b", metaKey: true }), fakeTerminal(), wsRef()),
    ).toBe(false);
  });

  it("⌘1 is declined (registry pane chord)", () => {
    expect(
      handleKeyEvent(
        key({ key: "1", code: "Digit1", metaKey: true }),
        fakeTerminal(),
        wsRef(),
      ),
    ).toBe(false);
  });

  it("⌘W stays declined (browser-owned chord; xterm must not react as the tab closes)", () => {
    expect(
      handleKeyEvent(key({ key: "w", metaKey: true }), fakeTerminal(), wsRef()),
    ).toBe(false);
  });

  it("plain ⌘K is the quick-switcher (declined); ⌘⇧K clears", () => {
    const term = fakeTerminal();
    expect(
      handleKeyEvent(key({ key: "k", metaKey: true }), term, wsRef()),
    ).toBe(false);
    expect(term.clear).not.toHaveBeenCalled();
    expect(
      handleKeyEvent(
        key({ key: "K", code: "KeyK", metaKey: true, shiftKey: true }),
        term,
        wsRef(),
      ),
    ).toBe(false);
    expect(term.clear).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { pushEscapeCloser } from "../shortcuts/escapeStack";
import type { TerminalInstance } from "../terminal/types";
import { handleKeyEvent } from "./useTerminal";

/**
 * Terminal key policy, NON-MAC half (jsdom's platform is not mac, so `mod` is
 * Ctrl — matching Linux/Windows users). The mac half lives in
 * useTerminal.keyPolicy.mac.dom.test.ts with a mocked platform module.
 *
 * Return-value contract: true = xterm processes the key (it reaches the PTY),
 * false = declined.
 */

function fakeTerminal() {
  return {
    clear: vi.fn(),
    selectAll: vi.fn(),
  } as unknown as TerminalInstance;
}

function wsRef() {
  return {
    current: { readyState: WebSocket.OPEN, send: vi.fn() },
  } as unknown as React.RefObject<WebSocket | null>;
}

function key(init: KeyboardEventInit & { type?: string }) {
  const { type = "keydown", ...rest } = init;
  return new KeyboardEvent(type, rest);
}

describe("handleKeyEvent — non-mac (mod = Ctrl)", () => {
  it("Ctrl+D reaches the shell (EOF freed by ADR-065; was legacy-swallowed)", () => {
    expect(
      handleKeyEvent(key({ key: "d", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(true);
  });

  it("Ctrl+W stays declined (Chromium's unpreventable close-tab — see comment at the case)", () => {
    expect(
      handleKeyEvent(key({ key: "w", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(false);
  });

  it("Ctrl+B is declined via the REGISTRY (mod+b = sidebar), not a hardcoded list", () => {
    expect(
      handleKeyEvent(key({ key: "b", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(false);
  });

  it("Ctrl+Shift+W is also declined (close-WINDOW, same unpreventable class)", () => {
    expect(
      handleKeyEvent(
        key({ key: "W", ctrlKey: true, shiftKey: true }),
        fakeTerminal(),
        wsRef(),
      ),
    ).toBe(false);
  });

  it("Ctrl+R (readline reverse-search) passes through", () => {
    expect(
      handleKeyEvent(key({ key: "r", ctrlKey: true }), fakeTerminal(), wsRef()),
    ).toBe(true);
  });

  it("plain typing passes through", () => {
    expect(handleKeyEvent(key({ key: "a" }), fakeTerminal(), wsRef())).toBe(
      true,
    );
  });

  it("Escape passes to the terminal normally, but is declined while a dismissal is open", () => {
    const esc = () =>
      handleKeyEvent(
        key({ key: "Escape", code: "Escape" }),
        fakeTerminal(),
        wsRef(),
      );
    expect(esc()).toBe(true); // TUIs get their Escape

    const pop = pushEscapeCloser(vi.fn());
    expect(esc()).toBe(false); // registry ui.dismiss owns it while open
    pop();
    expect(esc()).toBe(true);
  });

  it("plain mod+K is the quick-switcher (registry declines it); SHIFT+K clears", () => {
    const term = fakeTerminal();
    // mod+k → app-reserved (agent.quickswitch) → declined, clear NOT called.
    expect(
      handleKeyEvent(key({ key: "k", ctrlKey: true }), term, wsRef()),
    ).toBe(false);
    expect(term.clear).not.toHaveBeenCalled();
    // mod+shift+K → terminal clear (moved by the quick-switcher ADR).
    // Matched on the PRINTED letter, lowercased: plain Shift gives "K",
    // CapsLock+Shift gives "k" — both clear. On Dvorak the physical KeyK
    // prints "t": that chord must NOT clear (a code-based match would have
    // silently stolen mod+shift+T there).
    expect(
      handleKeyEvent(
        key({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }),
        term,
        wsRef(),
      ),
    ).toBe(false);
    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(
      handleKeyEvent(
        key({ key: "k", code: "KeyK", ctrlKey: true, shiftKey: true }), // CapsLock
        term,
        wsRef(),
      ),
    ).toBe(false);
    expect(term.clear).toHaveBeenCalledTimes(2);
    expect(
      handleKeyEvent(
        key({ key: "t", code: "KeyK", ctrlKey: true, shiftKey: true }), // Dvorak
        term,
        wsRef(),
      ),
    ).toBe(true); // passes to xterm — we did not steal mod+shift+T
    expect(term.clear).toHaveBeenCalledTimes(2);
  });

  it("non-keydown events are never intercepted", () => {
    expect(
      handleKeyEvent(
        key({ type: "keypress", key: "d", ctrlKey: true }),
        fakeTerminal(),
        wsRef(),
      ),
    ).toBe(true);
  });
});

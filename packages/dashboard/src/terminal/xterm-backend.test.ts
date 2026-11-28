import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { createXtermBackend, resetInactiveAltBuffer } from "./xterm-backend";

/**
 * ADR-162: the "bottom half on top" no_flicker rotation, on the real xterm.
 * The pane fits its box (49 rows), the replay-begin marker shrinks it to the
 * PTY's size (43 rows) while the NORMAL buffer is active, the replay enters
 * the alternate screen and draws a frame taller than 43 rows (history from
 * when the PTY was bigger), and the pane re-fits to 49. Without the
 * workaround the alt buffer ends with ybase = 6: a scroll offset on a buffer
 * with no scrollback, so every row lands 6 below where it's read, wrapping.
 */
describe("createXtermBackend — alternate buffer across a rows shrink (ADR-162)", () => {
  const options = {
    cursorBlink: false,
    fontSize: 14,
    fontFamily: "monospace",
    scrollback: 1000,
  };
  const write = (
    t: { write: (d: string, cb: () => void) => void },
    d: string,
  ) => new Promise<void>((r) => t.write(d, r));
  const tallFrame = `\x1b[H${Array.from({ length: 49 }, (_, r) => `row-${r}`).join("\r\n")}\x1b[38;1H`;

  it("a shrink on the normal buffer, then ?1049h, leaves no scroll offset on the alternate screen", async () => {
    const { terminal } = createXtermBackend({
      ...options,
      cols: 141,
      rows: 49,
    });
    terminal.resize(116, 43); // replay-begin: the PTY's size
    await write(terminal, `\x1b[?1049h${tallFrame}`); // the replay
    terminal.resize(141, 49); // the post-replay refit
    const buf = terminal.buffer.active;
    expect(buf.type).toBe("alternate");
    expect(
      buf.baseY,
      "alt-screen scroll offset: rows are drawn baseY rows below where they're shown (the half-swap)",
    ).toBe(0);
    expect(
      buf.length,
      "alt buffer holds more lines than the screen has rows",
    ).toBe(49);
    terminal.dispose();
  });

  it("the same holds when the alternate screen is entered at the shrunk size (no refit)", async () => {
    const { terminal } = createXtermBackend({
      ...options,
      cols: 141,
      rows: 49,
    });
    terminal.resize(116, 43);
    await write(terminal, `\x1b[?1049h${tallFrame}`);
    expect(terminal.buffer.active.baseY).toBe(0);
    expect(terminal.buffer.active.length).toBe(43);
    terminal.dispose();
  });

  it("reaches xterm's internals on the installed xterm (an upgrade that moves them must fail here, not silently)", () => {
    const { terminal } = createXtermBackend({ ...options, cols: 80, rows: 24 });
    expect(resetInactiveAltBuffer(terminal as unknown as Terminal)).toBe(true);
    terminal.dispose();
  });
});

/**
 * Regression test for the xterm.js v6.0.0 DECRQM bug.
 *
 * Claude Code's Ink UI emits `CSI ? 2026 $ p` (DEC Request Mode — synchronized
 * output probe) during startup. xterm v6.0.0's built-in `requestMode` handler
 * throws `ReferenceError: t is not defined` after Vite minification, freezing
 * the terminal mid-write. `xterm-backend.ts` shadows the two `$ p` CSI handlers
 * with no-ops to sidestep the bug.
 *
 * These tests fail if those shadow handlers are removed:
 * - In dev (unminified): xterm's built-in handler would run and emit a DECRPM
 *   response via `onData`. Our shadow returns true first, so no response fires.
 * - In prod (minified): xterm's handler would throw.
 *
 * Either way, the `onData` expectation catches regression.
 */
describe("createXtermBackend — DECRQM shadow handlers", () => {
  const options = {
    cursorBlink: false,
    fontSize: 14,
    fontFamily: "monospace",
    scrollback: 1000,
  };

  function waitForParse(): Promise<void> {
    // xterm's WriteBuffer processes chunks asynchronously via setTimeout.
    // Wait long enough for the scheduler to drain.
    return new Promise((r) => setTimeout(r, 50));
  }

  it("does not emit a DECRPM response for CSI ? 2026 $ p (synchronized output)", async () => {
    const { terminal } = createXtermBackend(options);
    const responses: string[] = [];
    terminal.onData((d) => responses.push(d));

    terminal.write("\x1b[?2026$p");
    await waitForParse();

    expect(responses).toEqual([]);
    terminal.dispose();
  });

  it("does not emit a DECRPM response for CSI 4 $ p (ANSI mode probe)", async () => {
    const { terminal } = createXtermBackend(options);
    const responses: string[] = [];
    terminal.onData((d) => responses.push(d));

    terminal.write("\x1b[4$p");
    await waitForParse();

    expect(responses).toEqual([]);
    terminal.dispose();
  });

  it("continues processing subsequent writes after a DECRQM sequence", async () => {
    const { terminal } = createXtermBackend(options);
    let afterDecrqm = "";

    terminal.write("\x1b[?2026$p");
    terminal.write("hello", () => {
      afterDecrqm = "hello";
    });
    await waitForParse();

    expect(afterDecrqm).toBe("hello");
    terminal.dispose();
  });
});

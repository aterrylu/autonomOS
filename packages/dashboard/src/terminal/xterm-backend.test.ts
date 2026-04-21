import { describe, expect, it } from "vitest";
import { createXtermBackend } from "./xterm-backend";

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

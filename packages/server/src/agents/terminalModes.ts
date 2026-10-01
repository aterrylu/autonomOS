/**
 * Sticky terminal modes, tracked so a reconnect replay can restore them.
 *
 * A reconnecting pane resets its terminal and the server replays the session's
 * output buffer: the last 1MB of raw PTY bytes, trimmed from the front. Full-
 * screen TUIs set their modes ONCE at startup and then only draw. Measured on
 * real streams: Codex 0.154 sends `?1049h` (alternate screen) at byte 69 and
 * `?1007h` (alternate scroll: the wheel becomes arrow keys) at byte 89; Claude
 * Code with CLAUDE_CODE_NO_FLICKER=1 sends `?1049h` plus mouse tracking
 * (`?1000/1002/1003/1006h`). Once a session passes 1MB those bytes are trimmed
 * away, so the reset terminal never re-enters those modes. For Codex that left
 * the wheel dead: an alternate screen has no scrollback, and without `?1007h`
 * no arrow keys are sent ("the pane froze, I couldn't scroll").
 *
 * The fix keeps the mode state AT THE HEAD of the retained buffer (fed the
 * chunks as the trim drops them). Replaying that state's preamble and then the
 * retained bytes ends in exactly the live state, whatever was trimmed.
 *
 * Scanning is cheap: only `ESC [ ?` sequences are examined, located with
 * indexOf; nothing else is parsed.
 */

/** DEC private modes a TUI sets once and relies on afterwards. */
const STICKY = new Set([
  1, // DECCKM: application cursor keys
  25, // DECTCEM: cursor visible (default ON)
  47, // alternate screen (legacy)
  1047, // alternate screen
  1049, // alternate screen + saved cursor
  1000, // mouse: button press/release
  1002, // mouse: button-event tracking
  1003, // mouse: any-event tracking
  1004, // focus in/out reports
  1005, // mouse: UTF-8 coordinates
  1006, // mouse: SGR coordinates
  1007, // alternate scroll: wheel → arrow keys on the alternate screen
  1015, // mouse: urxvt coordinates
  2004, // bracketed paste
]);

/** Modes that are ON after a terminal reset; every other tracked mode is OFF. */
const DEFAULT_ON = new Set([25]);

const ALT_SCREEN = [1049, 1047, 47];

/** Longest incomplete sequence carried into the next chunk. A longer "partial"
 *  is not a mode sequence; dropping it bounds the carry. */
const MAX_CARRY = 64;

export class DecModeTracker {
  private readonly state = new Map<number, boolean>();
  private carry = "";

  feed(chunk: string): void {
    const s = this.carry ? this.carry + chunk : chunk;
    this.carry = "";
    let i = s.indexOf("\x1b");
    while (i !== -1) {
      // An escape sequence cut by the chunk boundary: finish it next feed.
      if (s.length - i < 2) {
        this.keepCarry(s, i);
        return;
      }
      if (s[i + 1] === "c") {
        // RIS (complete at two bytes): every mode back to its default.
        this.state.clear();
        i = s.indexOf("\x1b", i + 2);
        continue;
      }
      if (s.length - i < 3) {
        this.keepCarry(s, i);
        return;
      }
      if (s[i + 1] !== "[" || s[i + 2] !== "?") {
        i = s.indexOf("\x1b", i + 1);
        continue;
      }
      let j = i + 3;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if ((c >= 0x30 && c <= 0x39) || c === 0x3b) j++;
        else break;
      }
      if (j >= s.length) {
        this.keepCarry(s, i);
        return;
      }
      const final = s[j];
      if (final === "h" || final === "l") {
        for (const p of s.slice(i + 3, j).split(";")) {
          const n = Number(p);
          if (STICKY.has(n)) this.state.set(n, final === "h");
        }
      }
      i = s.indexOf("\x1b", j);
    }
  }

  private keepCarry(s: string, from: number): void {
    if (s.length - from <= MAX_CARRY) this.carry = s.slice(from);
  }

  /** Whether a mode is on (tracked modes only; unknown → its reset default). */
  isOn(mode: number): boolean {
    return this.state.get(mode) ?? DEFAULT_ON.has(mode);
  }

  /** Whether the alternate screen is active. */
  inAltScreen(): boolean {
    return ALT_SCREEN.some((m) => this.isOn(m));
  }

  /**
   * Escape sequences that move a freshly reset terminal into this state. Only
   * modes that differ from the reset default are emitted, so a session that
   * never left the defaults gets an empty preamble. The alternate screen goes
   * first: it saves and clears, and the replayed bytes then draw into it.
   */
  preamble(): string {
    let out = "";
    for (const m of ALT_SCREEN) {
      if (this.state.get(m) === true) out += `\x1b[?${m}h`;
    }
    for (const [m, on] of this.state) {
      if (ALT_SCREEN.includes(m)) continue;
      if (on !== DEFAULT_ON.has(m)) out += `\x1b[?${m}${on ? "h" : "l"}`;
    }
    return out;
  }
}

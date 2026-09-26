/**
 * Opt-in PTY input log: every byte autonomOS writes INTO an agent's terminal,
 * with who wrote it. Forensics for "something typed into my session" reports
 * (e.g. blank lines appearing in Claude Code's input after a server restart),
 * where the writer could be the auto-trust watcher, prompt re-delivery, the
 * usage-queue auto-Enter, a handoff paste, or the dashboard itself (keystrokes
 * AND the terminal's automatic answers to queries in replayed output).
 *
 * It records keystrokes, so it is guarded:
 *   - OFF unless turned on at server start, by AUTONOMOS_PTY_INPUT_LOG=1 or
 *     by a one-shot trigger file, $configDir/pty-input-log.on. The installed
 *     service passes only HOME and PATH to the server, so the file is the way
 *     to reach it: the server deletes the file as it turns logging on, so it
 *     covers ONE start. If the file can't be deleted, logging stays OFF
 *     rather than coming back on at every start.
 *   - Control bytes and escape sequences are logged verbatim (the forensic
 *     signal: CR vs LF, ESC+CR, answers like \e[?1;2c). Printable text is
 *     logged only as a class and length (`<printable×12>`), as are OSC/DCS
 *     string bodies, unless AUTONOMOS_PTY_INPUT_LOG_TEXT=1 is also set.
 *   - The file is $configDir/logs/pty-input.log, 0600, size-capped and rotated.
 *   - It switches itself off after a window (AUTONOMOS_PTY_INPUT_LOG_MINUTES,
 *     default 30, max 240) counted from server start, and says so loudly both
 *     when it turns on and when it turns off.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRotatingWriter, type RotatingWriter } from "./logger.js";

/** Who wrote the bytes. `unattributed` = a write site nobody tagged. */
export type PtyInputSource =
  | "terminal"
  | "auto-trust"
  | "prompt-delivery"
  | "usage-queue"
  | "handoff";

export const DEFAULT_WINDOW_MINUTES = 30;
export const MAX_WINDOW_MINUTES = 240;
const MAX_BYTES = 5 * 1024 * 1024;
/** One-shot switch for the installed service (see the header). */
export const TRIGGER_FILE = "pty-input-log.on";
const KEEP = 2;
/** A CSI that hasn't reached its final byte by now isn't one; stop consuming
 *  so a stray `\e[` can't swallow (and print) what follows. */
const MAX_CSI_LEN = 32;

// ── Source attribution ───────────────────────────────────────────────
// Every PTY write is synchronous, so a module-level "current source" set
// around the call is exact: nothing else can run between set and restore.
let currentSource: PtyInputSource | null = null;

/** Run `fn` (a synchronous PTY write) attributed to `source`. */
export function withPtyInputSource<T>(source: PtyInputSource, fn: () => T): T {
  const prev = currentSource;
  currentSource = source;
  try {
    return fn();
  } finally {
    currentSource = prev;
  }
}

// ── Rendering (the redaction) ────────────────────────────────────────

const CONTROL_NAMES: Record<string, string> = {
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
};

function controlToken(ch: string): string {
  return (
    CONTROL_NAMES[ch] ?? `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
}

const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

/**
 * Render one write for the log: control bytes and escape sequences verbatim
 * (escaped so the line stays one line), printable text as `<printable×N>`
 * unless `text` is set. N counts characters (code points), not bytes.
 */
export function renderPtyInput(data: string, text = false): string {
  const chars = [...data];
  let out = "";
  let run = "";
  const flush = (): void => {
    if (!run) return;
    out += text ? run.replace(/\\/g, "\\\\") : `<printable×${[...run].length}>`;
    run = "";
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\x1b") {
      flush();
      const next = chars[i + 1];
      if (next === "[") {
        // CSI: parameter/intermediate bytes then one final byte (0x40–0x7E).
        let j = i + 2;
        let seq = "\\e[";
        while (j < chars.length && j - i < MAX_CSI_LEN) {
          const c = chars[j].codePointAt(0) ?? 0;
          if (c < 0x20 || c > 0x7e) break;
          seq += chars[j];
          j++;
          if (c >= 0x40) break; // final byte
        }
        out += seq;
        i = j - 1;
      } else if (next === "O" && i + 2 < chars.length) {
        out += `\\eO${chars[i + 2]}`; // SS3 (arrows/F-keys in app mode)
        i += 2;
      } else if (next === "]" || next === "P" || next === "_" || next === "^") {
        // OSC / DCS / APC / PM: a string body up to BEL or ESC \. The body
        // can carry text (clipboard, titles), so it is redacted like text.
        let j = i + 2;
        let body = "";
        let term = "";
        while (j < chars.length) {
          if (chars[j] === "\x07") {
            term = "\\x07";
            break;
          }
          if (chars[j] === "\x1b" && chars[j + 1] === "\\") {
            term = "\\e\\\\";
            j++;
            break;
          }
          body += chars[j];
          j++;
        }
        const shown = text
          ? body.replace(/\\/g, "\\\\")
          : `<string×${[...body].length}>`;
        out += `\\e${next}${shown}${term}`;
        i = j;
      } else if (next !== undefined) {
        // ESC + one key = Meta/Alt-modified key (ESC+CR is Meta-Enter).
        const c = next.codePointAt(0) ?? 0;
        out += `\\e${isControl(c) ? controlToken(next) : next}`;
        i += 1;
      } else {
        out += "\\e"; // lone ESC at the end of the write
      }
    } else if (isControl(code)) {
      flush();
      out += controlToken(ch);
    } else {
      run += ch;
    }
  }
  flush();
  return out;
}

// ── State ────────────────────────────────────────────────────────────

interface LogState {
  writer: RotatingWriter;
  text: boolean;
  until: number;
  now: () => number;
  expiredNoted: boolean;
}

let state: LogState | null = null;

export interface PtyInputLogOptions {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test hook: segment size cap. */
  maxBytes?: number;
}

function windowMinutes(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MINUTES;
  return Math.min(Math.max(1, Math.round(n)), MAX_WINDOW_MINUTES);
}

function stamp(now: number): string {
  return new Date(now).toISOString();
}

/**
 * Decide once at startup. Returns the log path when logging is on, null when
 * off (the default). Never throws: any failure leaves logging off and says so.
 */
export function initPtyInputLog(opts: PtyInputLogOptions): string | null {
  const env = opts.env ?? process.env;
  state = null;
  const byEnv = env.AUTONOMOS_PTY_INPUT_LOG === "1";
  const trigger = join(opts.configDir, TRIGGER_FILE);
  const byFile = existsSync(trigger);
  if (byFile) {
    try {
      rmSync(trigger);
    } catch (err) {
      console.warn(
        `[pty-input-log] could not remove ${trigger}; input logging stays OFF so it can't come back on at every start:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
  if (!byEnv && !byFile) return null;
  const now = opts.now ?? Date.now;
  const text = env.AUTONOMOS_PTY_INPUT_LOG_TEXT === "1";
  const minutes = windowMinutes(env.AUTONOMOS_PTY_INPUT_LOG_MINUTES);
  const path = join(opts.configDir, "logs", "pty-input.log");
  let writer: RotatingWriter;
  try {
    writer = createRotatingWriter(
      path,
      opts.maxBytes ?? MAX_BYTES,
      KEEP,
      0o600,
    );
  } catch (err) {
    console.warn(
      "[pty-input-log] could not open the log file; input logging stays OFF:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const until = now() + minutes * 60_000;
  state = { writer, text, until, now, expiredNoted: false };
  const banner =
    `[pty-input-log] ON: recording every byte written into agent terminals to ${path} ` +
    `until ${stamp(until)} (${minutes} min). Printable text is ` +
    (text
      ? "logged VERBATIM (AUTONOMOS_PTY_INPUT_LOG_TEXT=1), so passwords or secrets typed into a session WILL be in this file."
      : "redacted to its length.") +
    (byEnv
      ? " Unset AUTONOMOS_PTY_INPUT_LOG to stop it at the next start."
      : ` Turned on by ${TRIGGER_FILE}, which has been removed: this start only.`);
  console.warn(banner);
  writer.write(`${stamp(now())} ${banner}\n`);
  // Also announce the end on time, even if nothing is written after it.
  const t = setTimeout(() => noteExpired(), Math.max(0, until - now()));
  t.unref?.();
  return path;
}

function noteExpired(): void {
  const s = state;
  if (!s || s.expiredNoted) return;
  s.expiredNoted = true;
  const line = "[pty-input-log] window ended: input logging is now OFF.";
  console.warn(line);
  s.writer.write(`${stamp(s.now())} ${line}\n`);
}

/** Whether a write right now would be recorded. */
export function ptyInputLogActive(): boolean {
  const s = state;
  if (!s) return false;
  if (s.now() >= s.until) {
    noteExpired();
    return false;
  }
  return true;
}

/**
 * Wrap `pty.write` so each write is recorded (when logging is active) with
 * the session, the agent's label and the current source. A no-op when the
 * log is off at spawn time, so the default path is untouched.
 */
export function instrumentPtyInput(
  pty: { write(data: string): void },
  who: { sessionId: string; label: string },
): void {
  if (!state) return;
  const original = pty.write.bind(pty);
  const sid = who.sessionId.slice(0, 8);
  pty.write = (data: string): void => {
    if (ptyInputLogActive() && state) {
      const src = currentSource ?? "unattributed";
      state.writer.write(
        `${stamp(state.now())} ${sid} ${JSON.stringify(who.label)} ${src} ` +
          `len=${[...data].length} ${renderPtyInput(data, state.text)}\n`,
      );
    }
    original(data);
  };
}

/** Test hook: drop all state. */
export function _resetPtyInputLogForTest(): void {
  state = null;
  currentSource = null;
}

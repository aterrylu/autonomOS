/**
 * Per-pane connection health — the pure decisions behind the pane chip.
 *
 * The status-bar indicator answers "can I reach the server?" (the /ws/agents
 * heartbeat). It cannot answer "is THIS agent answering me?": with the server
 * healthy, a hung agent or a dead pane socket looked identical to a healthy
 * idle one — measured on an isolated rig, a SIGSTOPped claude sat behind a
 * green "Connected" and a "Ready" sidebar indefinitely.
 *
 * So each pane runs an input watchdog: a keystroke arms it, ANY byte back from
 * the terminal disarms it, and {@link WATCHDOG_MS} of total silence asks the
 * server (GET /api/agents/:id/io) which side is silent. Total silence, not "no
 * reply": a busy agent keeps echoing and repainting — measured, Claude Code
 * echoed typed text within 1s in the middle of a 40s tool run — so a long tool
 * run never trips it.
 */

/** Silence after an unanswered keystroke before the pane asks the server. */
export const WATCHDOG_MS = 5_000;

/** How long the "N keystrokes may not have been sent" notice stays after a
 *  pane reconnects. */
export const DROPPED_NOTICE_MS = 8_000;

/**
 * Providers whose TUI is MEASURED to echo input while busy, so silence really
 * means "not responding". A provider that legitimately goes quiet mid-turn
 * would get a false "Agent not responding" on every long turn, so a new one
 * stays OFF this list until measured. The connection-lost verdict is
 * transport-level and applies to all providers regardless.
 *
 * Measured 2026-09-24 on an isolated rig, typing mid-turn:
 *   claude-code 2.1.281 — echoed ≤1s during a 40s Bash tool run; spinner
 *                         repaints continuously.
 *   codex 0.154.0       — echoed immediately while "Working (3s…)"; the
 *                         working timer repaints every second.
 *   gemini-cli 0.46.0   — echoed immediately while "Thinking… (4s)"; its
 *                         timer repaints every second.
 * Re-verify on a provider's major TUI change (same checkpoint as the
 * trust-dialog and channel-flag re-checks).
 */
export const SILENT_CHIP_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "gemini-cli",
]);

export type PaneConnection =
  /** Nothing to report. `droppedKeys` > 0 = show the post-reconnect notice. */
  | { kind: "ok"; droppedKeys: number }
  /** The pane's socket is gone or being replaced. */
  | { kind: "lost"; droppedKeys: number }
  /** Server got our input; the agent has printed nothing since `since`. */
  | { kind: "silent"; since: number };

export const PANE_OK: PaneConnection = { kind: "ok", droppedKeys: 0 };

/**
 * Keystrokes that should visibly produce output: printable text (including a
 * paste), Enter, Backspace, Tab. Escape sequences (arrows, function keys,
 * focus reports) and other control bytes are excluded — an arrow at a
 * boundary legitimately changes nothing on screen, and must neither arm the
 * watchdog nor count as a "dropped keystroke".
 */
export function isCountableInput(data: string): boolean {
  if (data.length === 0 || data.charCodeAt(0) === 0x1b) return false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c >= 0x20 || c === 0x0d || c === 0x7f || c === 0x09 || c === 0x08) {
      return true;
    }
  }
  return false;
}

export interface IoProbe {
  /** ms since the server last wrote a terminal keystroke into the PTY. */
  inputAgeMs: number | null;
  /** ms since the PTY last produced output. */
  outputAgeMs: number | null;
}

/** Slack for request latency + timer jitter between "armed" and the probe. */
const SKEW_MS = 1_000;

/**
 * Which side is silent, given the server's view and how long ago (by our own
 * clock) the unanswered keystroke was sent. Ages, not timestamps, so the
 * verdict survives browser/server clock skew.
 *
 * - The server has NOT received input since we armed → our keys never
 *   arrived → the pane socket is dead.
 * - The server produced output AFTER our keystroke that we never received →
 *   the downstream half is dead → the pane socket is dead.
 * - Otherwise the server has our input and the agent has printed nothing
 *   since → the agent is silent.
 */
export function classifyIoProbe(
  io: IoProbe,
  elapsedSinceKeyMs: number,
): "socket-dead" | "agent-silent" {
  if (io.inputAgeMs === null || io.inputAgeMs > elapsedSinceKeyMs + SKEW_MS) {
    return "socket-dead";
  }
  if (io.outputAgeMs !== null && io.outputAgeMs < elapsedSinceKeyMs - SKEW_MS) {
    return "socket-dead";
  }
  return "agent-silent";
}

/**
 * Replayed-scrollback replies. On every socket open the server replays the
 * session's whole scrollback, and xterm answers every query it parses in that
 * history — device attributes, cursor position, mode and color reports —
 * through onData, exactly as if the user typed them. Measured on a rig:
 * after a reconnect, gemini-cli's prompt filled with "1;2c1;2c1;2c" (DA1
 * replies). Pre-existing on any reconnect or page reload; frequent now that a
 * stale transport force-reconnects every pane.
 *
 * So replies are dropped from each open until the server's end-of-replay
 * marker (OSC {@link REPLAY_END_OSC}, requested with `?replayMark=1`) is
 * PARSED — the exact end of the replay, however long xterm takes to chew
 * through it (large replays are parsed in time slices, and background tabs
 * throttle those). Live query replies right after it — a fresh agent's
 * startup capability probes — go through untouched. The caps only bound a
 * server that never sends the marker: short until this page has seen one,
 * generous after (the dashboard is served by its own server, so they match).
 */
export const REPLAY_END_OSC = 7777;
export const REPLAY_REPLY_CAP_MS = 60_000;
export const REPLAY_REPLY_CAP_UNCONFIRMED_MS = 5_000;

/**
 * Is `data` a terminal's automatic answer to a query, rather than something a
 * person typed? Deliberately narrow: only complete reply sequences match, so
 * a real keystroke (arrows, function keys, Alt-combos, paste) never does.
 * Focus in/out (ESC[I / ESC[O) are NOT included — those come from focus
 * events, not from parsing replayed output. Known collision: xterm encodes a
 * modified F3 (e.g. Shift+F3) as ESC[1;2R — the CPR shape — so that one key
 * is dropped if pressed within the window. Accepted: 2s, one rarely-bound
 * key, versus garbage typed into every agent on every reconnect.
 */
export function isTerminalReply(data: string): boolean {
  return (
    // DA1 / DA2 / DA3: ESC[?…c, ESC[>…c, ESC[=…c
    /^\x1b\[[?>=][\d;]*c$/.test(data) ||
    // CPR ESC[<row>;<col>R and DSR status ESC[0n / ESC[3n
    /^\x1b\[\d+;\d+R$/.test(data) ||
    /^\x1b\[[03]n$/.test(data) ||
    // DECRPM mode reports: ESC[?<mode>;<v>$y and ESC[<mode>;<v>$y
    /^\x1b\[\??\d+;\d+\$y$/.test(data) ||
    // Kitty keyboard-protocol flags report: ESC[?<flags>u
    /^\x1b\[\?\d+u$/.test(data) ||
    // OSC color reports (10/11/12 fg/bg/cursor, 4 palette), BEL or ST
    /^\x1b\](?:1[0-2]|4;\d+);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)$/.test(data) ||
    // DCS replies (XTVERSION, DECRQSS): ESC P … ESC \
    /^\x1bP[\s\S]*\x1b\\$/.test(data)
  );
}

/**
 * Input the USER produced (as opposed to the terminal answering on its own):
 * everything except query replies and focus in/out reports. This is what the
 * accounting counts and what arms the watchdog's socket-dead check — Esc and
 * Ctrl+C included (an interrupt that never landed must not go unnoticed),
 * even though only {@link isCountableInput} keys can blame a silent agent.
 */
export function isUserInput(data: string): boolean {
  return (
    data.length > 0 &&
    data !== "\x1b[I" &&
    data !== "\x1b[O" &&
    !isTerminalReply(data) &&
    !isMouseReport(data)
  );
}

/**
 * Mouse reports a TUI that enabled mouse tracking receives on every click or
 * wheel (Claude Code does): SGR `ESC[<b;x;yM|m` and legacy X10 `ESC[M` + 3
 * bytes. Still SENT like any input — but they are not keystrokes, so they
 * neither count toward "N keystrokes not sent" (measured: one click added 3
 * to the count) nor arm the watchdog (a click often, legitimately, prints
 * nothing).
 */
export function isMouseReport(data: string): boolean {
  return (
    /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || /^\x1b\[M[\s\S]{3}$/.test(data)
  );
}

/** A per-page id for the terminal socket's superseded-socket fence (see
 *  routes/terminal.ts): the server drops input arriving on an older
 *  generation once a newer one from the same client has opened. */
export const TERMINAL_CLIENT_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
})();

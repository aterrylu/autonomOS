import type { Turn } from "@autonomos/core";

// ── Conversation thread layout helpers ───────────────────────────────────────
// Pure logic extracted from ConversationView so it can be unit-tested without
// a DOM / React render environment (the dashboard test runner is node-env).

// Sub-agent color palette — cycles for each distinct sidechain "block".
export const SIDECHAIN_COLORS = [
  "#53bdfa",
  "#fae38e",
  "#90e1c6",
  "#ea6c73",
  "#c792ea",
];

// Progressive-reveal tuning. The thread renders the most-recent INITIAL_REVEAL
// turns on first paint (fast, correct auto-scroll-to-bottom), then reveals
// older turns REVEAL_BATCH at a time during idle frames — turning one multi-
// second blocking render of the whole transcript into incremental work.
export const INITIAL_REVEAL = 60;
export const REVEAL_BATCH = 40;

export interface DecoratedTurn {
  turn: Turn;
  /** Original index in the full turns array — used as a stable React key. */
  index: number;
  /** Color for this turn if it is part of a sidechain run. */
  sidechainColor: string;
  /** True for the first turn of a contiguous sidechain run (renders the header). */
  showSidechainHeader: boolean;
}

/**
 * Annotate every turn with sidechain color + header flags, computed over the
 * FULL turns array so colors stay stable regardless of how many turns are
 * currently revealed. Each contiguous run of sidechain turns advances to the
 * next palette color.
 */
export function decorateTurns(turns: Turn[]): DecoratedTurn[] {
  let sidechainIndex = -1;
  let lastWasSidechain = false;

  return turns.map((turn, i) => {
    const isSidechain = !!turn.isSidechain;
    if (isSidechain && !lastWasSidechain) sidechainIndex++;
    const showSidechainHeader =
      isSidechain && (i === 0 || !turns[i - 1]?.isSidechain);
    lastWasSidechain = isSidechain;

    // Positive modulo so a not-yet-seen run (sidechainIndex === -1, unused for
    // non-sidechain turns) never indexes out of bounds.
    const safeIndex =
      ((sidechainIndex % SIDECHAIN_COLORS.length) + SIDECHAIN_COLORS.length) %
      SIDECHAIN_COLORS.length;

    return {
      turn,
      index: i,
      sidechainColor: SIDECHAIN_COLORS[safeIndex],
      showSidechainHeader,
    };
  });
}

/**
 * The slice of decorated turns to render given how many are currently
 * revealed. Reveals from the END (most-recent) so the first paint shows the
 * bottom of the conversation.
 */
export function revealWindow(
  decorated: DecoratedTurn[],
  revealed: number,
): DecoratedTurn[] {
  const start = Math.max(0, decorated.length - revealed);
  return decorated.slice(start);
}

/** requestIdleCallback with a setTimeout fallback (Safari, jsdom). */
export function scheduleIdle(cb: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(cb, { timeout: 200 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

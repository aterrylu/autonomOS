/**
 * Which digit chord focuses the pane at `index` (0-based, VISUAL order —
 * the same `orderedPaneIds` enumeration the mod+digit shortcuts use), given
 * `count` open panes. Null = no digit reaches this pane.
 *
 * Mirrors the registry exactly: mod+1..8 are positional; mod+9 is LAST
 * (the Ghostty/Warp/VS Code idiom), so:
 *  - positions 0..7 → digits 1..8
 *  - the last pane → 9, but only when its position is beyond 8 (with ≤9
 *    panes its positional digit already reaches it — show that instead;
 *    with exactly 9 panes, position 8 IS the last pane, digit 9)
 *  - positions 8+ that aren't last → unreachable, no badge
 *
 * The badge IS the digit that fires, so the hint can never lie.
 */
export function digitForPane(index: number, count: number): number | null {
  if (count < 2) return null; // a lone pane needs no hint
  if (index < 0 || index >= count) return null;
  if (index === count - 1 && index >= 8) return 9;
  if (index < 8) return index + 1;
  return null;
}

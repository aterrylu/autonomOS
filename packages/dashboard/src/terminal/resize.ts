/**
 * Pure terminal-resize guards (no DOM / xterm deps, so they're unit-testable on
 * their own).
 */

/**
 * The FitAddon floors at 2 cols / 1 row; a fit against an unsettled renderer
 * (e.g. just after a WebGL context loss) can collapse to that floor. Such a size
 * is never a real layout, so callers must refuse to propagate it to the PTY —
 * doing so is what makes the terminal "shrink to a weird tiny state" on idle.
 */
export function isDegenerate(cols: number, rows: number): boolean {
  return cols <= 2 || rows <= 1;
}

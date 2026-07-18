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

// A real monospace terminal cell is never wider than ~30px or taller than ~60px,
// even at large accessibility font sizes (browser zoom scales the container box
// too, so these CSS-pixel bounds hold under zoom). If a fit implies a cell bigger
// than this, the renderer hadn't measured its cell yet and produced too-few
// cols/rows — a mis-measure, not a real layout.
const MAX_PLAUSIBLE_CELL_W = 30;
const MAX_PLAUSIBLE_CELL_H = 60;

/**
 * Is a fit result plausible for the given container pixel box?
 *
 * `isDegenerate` only rejects the FitAddon's 2×1 floor, but an unsettled renderer
 * typically yields a *small-but->2* size (e.g. 20 cols in an 800px-wide pane —
 * implying a 40px cell). That sails through the degenerate guard and, once shipped
 * to the PTY, wedges the remote tty at a wrong size that the ResizeObserver's
 * change-cache then never corrects (the idle self-shrink). Reject any fit whose
 * implied cell size exceeds a sane monospace maximum so callers can retry on a
 * later, settled frame instead of propagating garbage.
 */
export function isPlausibleFit(
  cols: number,
  rows: number,
  widthPx: number,
  heightPx: number,
): boolean {
  if (isDegenerate(cols, rows)) return false;
  if (widthPx <= 0 || heightPx <= 0) return false;
  return (
    widthPx / cols <= MAX_PLAUSIBLE_CELL_W &&
    heightPx / rows <= MAX_PLAUSIBLE_CELL_H
  );
}

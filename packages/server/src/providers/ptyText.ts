/**
 * Reading a TUI's PTY output as text — shared by the startup watchers.
 *
 * The CSI prefix class includes the private-parameter markers <=>? — without
 * them, sequences like `\x1b[>0q` (DECRQM/mode chatter CC emits around
 * dialogs) strip only partially and leak fragments ("0q", "4m") into the
 * needle buffer. Those fragments once counted as "fresh output" and
 * false-settled a dialog that was still on screen.
 */
export const ANSI_RE =
  /\x1b[[\]()#;?<=>]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

/**
 * All whitespace removed — the normal form needles match on. Real renders
 * interleave cursor-positioning CSI with the glyphs, so after ANSI stripping
 * the spacing inside a label is arbitrary; a literal-spacing needle can
 * silently never match.
 */
export function despace(s: string): string {
  return s.replace(/\s+/g, "");
}

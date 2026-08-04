/**
 * The Escape dismissal stack (ADR-065) — the registry's answer to "which of
 * the open overlays/popovers should Escape close?"
 *
 * Why it exists: the popovers' previous document-level bubble-phase Escape
 * listeners were DEAD whenever a terminal had focus — xterm stopPropagation()s
 * every key it handles, Escape included. That was masked by focus-follows-
 * click (opening a popover moves focus to its toggle button) and broke the
 * moment focus returned to a terminal: Escape fed \x1b to the shell while the
 * popover stayed open. Dismissal now runs through the registry's single
 * capture-phase Escape entry (`ui.dismiss`), which wins over xterm and is
 * reserved ONLY while something is actually open — terminals keep Escape the
 * rest of the time.
 *
 * Contract: anything dismissible (help overlay, status-bar popovers,
 * notification panel) pushes its close callback while mounted-open and pops on
 * unmount (via the returned cleanup — safe to call twice). LIFO: Escape closes
 * the most recently opened thing first, which is what nesting expects.
 */

const stack: Array<() => void> = [];

/** Register `close` as the current top dismissal. Returns an idempotent
 *  cleanup that removes exactly this registration (by identity, from the top
 *  down, so duplicate callbacks pop in LIFO order). */
export function pushEscapeCloser(close: () => void): () => void {
  stack.push(close);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = stack.lastIndexOf(close);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Whether anything is currently dismissible (the `ui.dismiss` `when` gate). */
export function hasEscapeCloser(): boolean {
  return stack.length > 0;
}

/** Close the top of the stack. No-op when empty (the registry's `when` gate
 *  makes that unreachable via keyboard, but direct calls stay safe).
 *
 *  Deliberately does NOT pop on success — the closer unmounts its owner,
 *  whose effect cleanup pops the entry (popping eagerly would desync when a
 *  close is vetoed or async). A THROWING closer forfeits its slot, though:
 *  without the force-pop, a reliably-throwing closer would keep Escape
 *  reserved forever — eaten from terminals, broken for everything. Better to
 *  hand Escape back to the terminal than reserve it for a broken panel. */
export function closeTopEscape(): void {
  const top = stack[stack.length - 1];
  if (!top) return;
  try {
    top();
  } catch (err) {
    const i = stack.lastIndexOf(top);
    if (i !== -1) stack.splice(i, 1);
    console.error(
      "[autonomOS] escape closer threw; dropping its dismissal registration so Escape is not permanently reserved:",
      err,
    );
  }
}

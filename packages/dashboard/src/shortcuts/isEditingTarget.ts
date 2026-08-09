/** True when focus is in an editable TEXT field the user is typing in —
 *  excluding xterm's hidden helper textarea, which is the terminal's input
 *  proxy (shortcuts must still win there; that is the whole boundary). */
export function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.classList.contains("xterm-helper-textarea")) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

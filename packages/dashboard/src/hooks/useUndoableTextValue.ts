import { useCallback, useRef } from "react";

/**
 * Restores Cmd/Ctrl+Z undo (and Cmd/Ctrl+Shift+Z redo) for a React
 * **controlled** text input/textarea.
 *
 * The problem: a controlled component (`value={state}` + `onChange`)
 * replaces the element's entire value on every keystroke. That wipes the
 * browser's native undo stack, so Cmd+Z does nothing — if a user
 * accidentally clears the field, the text is gone for good.
 *
 * The fix: keep our own undo/redo history. We snapshot the value before
 * each change and intercept Cmd/Ctrl+Z to restore it. Because a
 * select-all-then-delete fires a single `onChange`, one undo restores the
 * whole cleared block.
 *
 * Usage:
 *   const undoable = useUndoableTextValue(text, setText);
 *   <textarea value={text} {...undoable} />
 *
 * The returned `onChange`/`onKeyDown` fully replace the ones you would
 * otherwise pass; the hook calls `setValue` for you.
 */

// Continuous keystrokes within this window collapse into one undo step,
// matching the browser's native word-at-a-time undo granularity.
const COALESCE_MS = 500;

type TextEl = HTMLTextAreaElement | HTMLInputElement;

interface UndoableHandlers<T extends TextEl> {
  onChange: (e: React.ChangeEvent<T>) => void;
  onKeyDown: (e: React.KeyboardEvent<T>) => void;
}

export function useUndoableTextValue<T extends TextEl = HTMLTextAreaElement>(
  value: string,
  setValue: (next: string) => void,
): UndoableHandlers<T> {
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastEditAt = useRef(0);

  const onChange = useCallback(
    (e: React.ChangeEvent<T>) => {
      const next = e.target.value;
      const prev = value;
      const now = Date.now();
      // Always snapshot a large change (e.g. a paste or a select-all
      // delete) so a single undo reverses it. Otherwise coalesce a burst
      // of single-character typing into one undo step.
      const bigChange = Math.abs(next.length - prev.length) > 1;
      const stale = now - lastEditAt.current > COALESCE_MS;
      if (bigChange || stale || past.current.length === 0) {
        past.current.push(prev);
      }
      lastEditAt.current = now;
      future.current = [];
      setValue(next);
    },
    [value, setValue],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<T>) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) {
        // Redo
        const redoValue = future.current.pop();
        if (redoValue === undefined) return;
        past.current.push(value);
        setValue(redoValue);
      } else {
        // Undo
        const undoValue = past.current.pop();
        if (undoValue === undefined) return;
        future.current.push(value);
        setValue(undoValue);
      }
    },
    [value, setValue],
  );

  return { onChange, onKeyDown };
}

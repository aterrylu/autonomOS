import { useEffect, useRef } from "react";
import { pushEscapeCloser } from "../../shortcuts/escapeStack";

/**
 * Calls `onClose` when clicking outside `ref` or pressing Escape.
 * Optionally ignores clicks inside `ignoreRef` (e.g. a toggle button).
 *
 * Escape is handled through the shortcut registry's escape stack (ADR-065),
 * not a document listener: a bubble-phase keydown listener is DEAD while a
 * terminal has focus (xterm stopPropagation()s handled keys), so the old
 * listener only appeared to work because opening a popover moves focus to its
 * toggle button. The stack registration makes Escape close this popover even
 * with a terminal focused — and keeps Escape unreserved when nothing is open.
 *
 * The registration is MOUNT-SCOPED and reads the latest `onClose` through a
 * ref: call sites pass inline arrows, and re-registering on every identity
 * change would MOVE this popover to the top of the LIFO stack on unrelated
 * re-renders — Escape would then close a panel hidden behind a newer overlay.
 */
export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  ignoreRef?: React.RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => pushEscapeCloser(() => closeRef.current()), []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (ignoreRef?.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) closeRef.current();
    }

    // Delay listener registration so the opening click doesn't
    // immediately trigger close via mousedown on the toggle button.
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [ref, ignoreRef]);
}

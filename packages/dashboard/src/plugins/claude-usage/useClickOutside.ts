import { useEffect } from "react";

/**
 * Calls `onClose` when clicking outside `ref` or pressing Escape.
 * Optionally ignores clicks inside `ignoreRef` (e.g. a toggle button).
 */
export function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  ignoreRef?: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (ignoreRef?.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [ref, onClose, ignoreRef]);
}

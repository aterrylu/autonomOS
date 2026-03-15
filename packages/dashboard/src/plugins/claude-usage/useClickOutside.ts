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

    // Delay listener registration so the opening click doesn't
    // immediately trigger close via mousedown on the toggle button.
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [ref, onClose, ignoreRef]);
}

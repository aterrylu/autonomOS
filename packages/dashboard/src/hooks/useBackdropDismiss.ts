import { useCallback, useRef } from "react";

/**
 * Backdrop-click dismissal that survives text selection.
 *
 * The classic `onClick={e => e.target === e.currentTarget && close()}` closes
 * a dialog when the user drag-selects text INSIDE it and releases the mouse
 * over the backdrop: the browser dispatches that `click` to the nearest
 * common ancestor of the mousedown and mouseup targets — which is the
 * backdrop itself. (Terry, copying release notes out of the update dialog.)
 *
 * Dismiss only when the press STARTED on the backdrop and the click also
 * lands on it. Spread the returned handlers onto the backdrop element.
 */
export function useBackdropDismiss(onDismiss: () => void): {
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
} {
  const pressedOnBackdrop = useRef(false);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    pressedOnBackdrop.current = e.target === e.currentTarget;
  }, []);
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const startedHere = pressedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      if (startedHere && e.target === e.currentTarget) onDismiss();
    },
    [onDismiss],
  );
  return { onMouseDown, onClick };
}

import { useCallback, useRef } from "react";

/**
 * Backdrop-click dismissal that survives text selection.
 *
 * The classic `onClick={e => e.target === e.currentTarget && close()}` closes
 * a dialog when the user drag-selects text INSIDE it and releases the mouse
 * over the backdrop: the browser dispatches that `click` to the nearest
 * common ancestor of the mousedown and mouseup targets — which is the
 * backdrop itself. (Terry, copying release notes out of the update dialog.)
 * The reverse gesture — press on the backdrop, release inside the dialog —
 * lands on the same ancestor for the same reason.
 *
 * Dismiss only when BOTH the press and the release happened on the backdrop.
 * Spread the returned handlers onto the backdrop element.
 */
export function useBackdropDismiss(onDismiss: () => void): {
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseUp: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
} {
  const pressedOnBackdrop = useRef(false);
  const releasedOnBackdrop = useRef(false);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    pressedOnBackdrop.current = e.target === e.currentTarget;
  }, []);
  const onMouseUp = useCallback((e: React.MouseEvent) => {
    releasedOnBackdrop.current = e.target === e.currentTarget;
  }, []);
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const both = pressedOnBackdrop.current && releasedOnBackdrop.current;
      pressedOnBackdrop.current = false;
      releasedOnBackdrop.current = false;
      if (both && e.target === e.currentTarget) onDismiss();
    },
    [onDismiss],
  );
  return { onMouseDown, onMouseUp, onClick };
}

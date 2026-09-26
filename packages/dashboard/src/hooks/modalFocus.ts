/**
 * What `aria-modal` promises and the browser doesn't do for us: while a modal
 * is up, the app behind it can't be reached by keyboard or pointer, and Tab
 * cycles inside the modal.
 *
 * `inert` goes on the app root (`#root`). Modals portal to <body>, so they
 * sit outside it. Holds are counted: the update dialog and the reconnect
 * overlay can overlap, and the root must stay inert until the last lets go.
 */

let holds = 0;

export function holdAppInert(): () => void {
  const root = document.getElementById("root");
  if (!root) return () => {};
  holds += 1;
  root.setAttribute("inert", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) root.removeAttribute("inert");
  };
}

const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Keydown handler for a modal's container: Tab and Shift+Tab wrap. */
export function trapTab(
  e: React.KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
): void {
  if (e.key !== "Tab" || !container) return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      !el.closest("[inert]") &&
      !el.closest("details:not([open]) > :not(summary)"),
  );
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  // Not among the items = focus is on the heading (tabIndex -1) or the
  // container itself: Tab goes to the first item, Shift+Tab to the last.
  const inside = active instanceof HTMLElement && items.includes(active);
  if (e.shiftKey ? !inside || active === first : !inside || active === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

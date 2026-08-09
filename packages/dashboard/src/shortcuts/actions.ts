import { focusTerminal } from "../hooks/useTerminal";
import { useStore } from "../store";

/**
 * THE switch-to-agent sequence — the single copy every entry point calls
 * (digit shortcuts, mod+arrows, the ⌘K switcher). Mirrors a sidebar row
 * click exactly: `switchPane` (navigation — restores the agent's bound
 * workspace or shows it solo), then terminal focus, then clear unread.
 */
export function focusAgentById(id: string): void {
  const st = useStore.getState();
  st.switchPane({ type: "session", id });
  focusTerminal(id);
  if (st.notificationCounts[id]) st.markNotificationsRead(id);
}

/**
 * Switch to the Nth agent row in the sidebar (0-based, RENDERED order — the
 * `sidebarRowOrder` list the Sidebar publishes). Out-of-range is a
 * deliberate no-op (mod+5 with three agents does nothing).
 */
export function focusAgentByIndex(index: number): void {
  const id = useStore.getState().sidebarRowOrder[index];
  if (id !== undefined) focusAgentById(id);
}

/**
 * Move to the previous (-1) / next (+1) agent row relative to the active one
 * — mod+↑ / mod+↓. Clamps at the ends (no wrap). With no active session row
 * as an anchor, ↓ enters the list at the top and ↑ at the bottom.
 */
export function focusAgentDelta(delta: -1 | 1): void {
  const st = useStore.getState();
  const order = st.sidebarRowOrder;
  if (order.length === 0) return;
  const activeId = st.activePane?.type === "session" ? st.activePane.id : null;
  const activeIndex = activeId ? order.indexOf(activeId) : -1;
  const target =
    activeIndex === -1
      ? delta > 0
        ? order[0]
        : order[order.length - 1]
      : order[Math.max(0, Math.min(order.length - 1, activeIndex + delta))];
  if (target === undefined || target === activeId) return;
  focusAgentById(target);
}

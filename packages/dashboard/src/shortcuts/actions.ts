import { focusTerminal } from "../hooks/useTerminal";
import { useStore } from "../store";

/**
 * Switch to the Nth agent row in the sidebar (0-based, RENDERED order — the
 * `sidebarRowOrder` list the Sidebar publishes). This is the mod+digit action
 * (ADR-066): digits target the agent list on the left, CMUX-tab style, not
 * open pane positions. Out-of-range is a deliberate no-op (mod+5 with three
 * agents does nothing, like every tabbed app).
 *
 * Mirrors a sidebar row click exactly: `switchPane` (navigation — restores
 * the agent's bound workspace or shows it solo), then terminal focus, then
 * clear unread.
 */
export function focusAgentByIndex(index: number): void {
  const st = useStore.getState();
  const id = st.sidebarRowOrder[index];
  if (id === undefined) return;
  st.switchPane({ type: "session", id });
  focusTerminal(id);
  if (st.notificationCounts[id]) st.markNotificationsRead(id);
}

/**
 * Move to the previous (-1) / next (+1) agent row relative to the active one
 * — mod+↑ / mod+↓, the complement to digits for >9-agent fleets. Clamps at
 * the ends (no wrap). With no active session row as an anchor, ↓ enters the
 * list at the top and ↑ at the bottom.
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
  st.switchPane({ type: "session", id: target });
  focusTerminal(target);
  if (st.notificationCounts[target]) st.markNotificationsRead(target);
}

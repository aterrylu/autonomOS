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

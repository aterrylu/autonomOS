import { useEffect, useRef } from "react";
import { THEMES, useStore } from "../store";
import { SessionPane } from "./SessionPane";

/**
 * Manages all active session views. Keeps terminal instances alive
 * across session switches — only toggles visibility (like VSCode tabs).
 *
 * Sessions are mounted when they appear in the live sessions list and
 * unmounted when they're removed (killed or PTY exited).
 */
export function SessionViewManager() {
  const sessionId = useStore((s) => s.sessionId);
  const sessions = useStore((s) => s.sessions);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  // Track which session IDs have been "seen" (mounted) so we keep them
  // alive even if the sessions list briefly flickers during a poll.
  const mountedRef = useRef(new Set<string>());

  // Sync mounted set with live sessions — add new ones, remove dead ones
  useEffect(() => {
    const liveIds = new Set(sessions.map((s) => s.id));
    // Add any new sessions
    for (const id of liveIds) {
      mountedRef.current.add(id);
    }
    // Remove sessions that are no longer live
    for (const id of mountedRef.current) {
      if (!liveIds.has(id)) {
        mountedRef.current.delete(id);
      }
    }
  }, [sessions]);

  // Collect session IDs to render: all live sessions
  const liveIds = sessions.map((s) => s.id);

  if (!sessionId) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: page.statusFg }}
      >
        Create or select a session to start
      </div>
    );
  }

  return (
    <>
      {liveIds.map((id) => (
        <SessionPane key={id} sessionId={id} visible={id === sessionId} />
      ))}
    </>
  );
}

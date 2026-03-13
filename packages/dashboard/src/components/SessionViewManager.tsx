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

  const liveIds = sessions.map((s) => s.id);
  const hasSelection = sessionId !== null;

  return (
    <>
      {!hasSelection && (
        <div
          className="flex flex-1 items-center justify-center text-sm"
          style={{ color: page.statusFg }}
        >
          Create or select a session to start
        </div>
      )}
      {liveIds.map((id) => (
        <SessionPane key={id} sessionId={id} visible={id === sessionId} />
      ))}
    </>
  );
}

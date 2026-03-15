import { THEMES, useStore } from "../store";
import { PreviewPane } from "./PreviewPane";
import { SessionPane } from "./SessionPane";

/**
 * Manages all active pane views. Keeps terminal instances alive
 * across switches — only toggles visibility (like VSCode tabs).
 * Also renders preview panes alongside sessions.
 */
export function SessionViewManager() {
  const activePane = useStore((s) => s.activePane);
  const sessions = useStore((s) => s.sessions);
  const previewPanes = useStore((s) => s.previewPanes);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const hasSelection = activePane !== null;

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
      {sessions.map((s) => (
        <SessionPane
          key={s.id}
          sessionId={s.id}
          visible={activePane?.type === "session" && activePane.id === s.id}
        />
      ))}
      {previewPanes.map((p) => (
        <PreviewPane
          key={p.id}
          preview={p}
          visible={activePane?.type === "preview" && activePane.id === p.id}
        />
      ))}
    </>
  );
}

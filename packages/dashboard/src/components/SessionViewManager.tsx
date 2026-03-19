import { THEMES, useStore } from "../store";
import { ConversationView } from "./conversation/ConversationView";
import { SplitLayout } from "../layout/SplitLayout";

/**
 * SessionViewManager — renders the main content area.
 *
 * In terminal mode: SplitLayout renders the pane tree chrome, and
 * SessionMountLayer (in App.tsx) absolutely positions all terminals/previews
 * into their slot rects.
 *
 * In conversation mode: the conversation view overlays the active session's
 * chat transcript. Splits are still supported in terminal mode.
 */
export function SessionViewManager() {
  const layout = useStore((s) => s.layout);
  const activePane = useStore((s) => s.activePane);
  const viewMode = useStore((s) => s.viewMode);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  if (!activePane) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: page.statusFg }}
      >
        Create or select a session to start
      </div>
    );
  }

  if (viewMode === "conversation" && activePane.type === "session") {
    return (
      <div className="relative z-10 flex flex-1 overflow-hidden">
        <ConversationView key={activePane.id} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <SplitLayout node={layout} />
    </div>
  );
}

import { SplitLayout } from "../layout/SplitLayout";
import { THEMES, useStore } from "../store";

/**
 * SessionViewManager — renders the main content area.
 *
 * SplitLayout renders the pane tree chrome, and SessionMountLayer (in
 * App.tsx) absolutely positions all terminals/previews into their slot rects.
 */
export function SessionViewManager() {
  const layout = useStore((s) => s.layout);
  const activePane = useStore((s) => s.activePane);
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  if (!activePane) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: page.statusFg }}
      >
        Create or select an agent to start
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <SplitLayout node={layout} />
    </div>
  );
}

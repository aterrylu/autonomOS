import { DockviewLayout } from "../layout/dockview/DockviewLayout";
import { SplitLayout } from "../layout/SplitLayout";
import { THEMES, useStore } from "../store";

/**
 * SessionViewManager — renders the main content area.
 *
 * Legacy engine: SplitLayout renders the pane tree chrome, and
 * SessionMountLayer (in App.tsx) absolutely positions all terminals/previews
 * into their slot rects. dockview engine (ADR-047): DockviewLayout owns both
 * chrome and content, and SessionMountLayer is not mounted. Selected by the
 * `layoutEngine` flag.
 */
export function SessionViewManager() {
  const layout = useStore((s) => s.layout);
  const activePane = useStore((s) => s.activePane);
  const layoutEngine = useStore((s) => s.layoutEngine);
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
      {layoutEngine === "dockview" ? (
        <DockviewLayout />
      ) : (
        <SplitLayout node={layout} />
      )}
    </div>
  );
}

import { DockviewLayout } from "../layout/dockview/DockviewLayout";
import { THEMES, useStore } from "../store";

/**
 * SessionViewManager — renders the main content area.
 *
 * DockviewLayout (ADR-047) owns both the pane chrome and content, keeping every
 * panel's xterm mounted across tab switches. It is the only layout engine.
 */
export function SessionViewManager() {
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
      <DockviewLayout />
    </div>
  );
}

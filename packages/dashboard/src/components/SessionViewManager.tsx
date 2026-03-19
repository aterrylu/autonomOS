import { THEMES, useStore } from "../store";
import { SplitLayout } from "../layout/SplitLayout";

/**
 * SessionViewManager — thin wrapper around SplitLayout.
 * All session/preview mounting is handled by SessionMountLayer in App.tsx.
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
        Create or select a session to start
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden relative">
      <SplitLayout node={layout} />
    </div>
  );
}

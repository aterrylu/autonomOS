import { THEMES, useStore } from "../store";
import type { TabItem } from "./layoutTree";

const TAB_HEIGHT = 28;

interface TabBarProps {
  leafId: string;
  tabs: TabItem[];
  activeTabIndex: number;
}

/**
 * Horizontal tab bar rendered inside each PaneSlot.
 * Auto-hides when the pane has only one tab (VS Code style).
 * Each tab shows the session/preview name and a close button.
 */
export function TabBar({ leafId, tabs, activeTabIndex }: TabBarProps) {
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const previewPanes = useStore((s) => s.previewPanes);
  const switchTabInLeaf = useStore((s) => s.switchTabInLeaf);
  const closeTab = useStore((s) => s.closeTab);
  const page = THEMES[theme].page;

  // Auto-hide for single tab
  if (tabs.length <= 1) return null;

  function getTabTitle(tab: TabItem): string {
    const { pane } = tab;
    if (pane.type === "session") {
      const session = sessions.find((s) => s.id === pane.id);
      return session?.name || pane.id.slice(0, 8);
    }
    if (pane.type === "preview") {
      const preview = previewPanes.find((p) => p.id === pane.id);
      return preview?.title || "Preview";
    }
    return "Tab";
  }

  return (
    <div
      className="flex items-center shrink-0 overflow-x-auto"
      style={{
        height: TAB_HEIGHT,
        background: page.bg,
        borderBottom: `1px solid ${page.border}`,
      }}
    >
      {tabs.map((tab, i) => {
        const isActive = i === activeTabIndex;
        return (
          <button
            key={tab.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => switchTabInLeaf(leafId, i)}
            className="flex items-center gap-1 px-3 text-[11px] shrink-0 cursor-pointer border-r transition-colors"
            style={{
              height: TAB_HEIGHT,
              background: isActive ? page.border : "transparent",
              color: isActive ? page.fg : page.statusFg,
              borderColor: page.border,
              borderBottom: isActive
                ? `2px solid ${page.fg}`
                : "2px solid transparent",
            }}
          >
            <span className="truncate max-w-[120px]">{getTabTitle(tab)}</span>
            {/* Close button — only show on hover or when active */}
            <button
              type="button"
              className={`ml-1 rounded hover:opacity-100 cursor-pointer ${isActive ? "opacity-60" : "opacity-0"}`}
              style={{
                fontSize: 10,
                lineHeight: 1,
                background: "none",
                border: "none",
                color: "inherit",
              }}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(leafId, tab.id);
              }}
              tabIndex={-1}
            >
              ✕
            </button>
          </button>
        );
      })}
    </div>
  );
}

export { TAB_HEIGHT };

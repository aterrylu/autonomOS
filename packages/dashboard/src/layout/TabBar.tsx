import {
  type AgentStatus,
  AgentStatusIcon,
} from "../components/ui/agent-status-icon";
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
 * Each tab shows a status icon, session/preview name, and a close button.
 */
export function TabBar({ leafId, tabs, activeTabIndex }: TabBarProps) {
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const previewPanes = useStore((s) => s.previewPanes);
  const agentStatuses = useStore((s) => s.agentStatuses);
  const switchTabInLeaf = useStore((s) => s.switchTabInLeaf);
  const closeTab = useStore((s) => s.closeTab);
  const page = THEMES[theme].page;

  // Always show tab bar — even for single tab (matches cmux)
  if (tabs.length === 0) return null;

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

  function getTabStatus(tab: TabItem): AgentStatus | null {
    if (tab.pane.type !== "session") return null;
    return (agentStatuses[tab.pane.id]?.status as AgentStatus) ?? "working";
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
        const status = getTabStatus(tab);
        return (
          <button
            key={tab.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => switchTabInLeaf(leafId, i)}
            className={`group/tab flex items-center gap-1.5 px-2 text-[11px] cursor-pointer border-r transition-colors min-w-0 ${isActive ? "font-medium" : "hover:brightness-125"}`}
            style={{
              height: TAB_HEIGHT,
              width: `${100 / tabs.length}%`,
              maxWidth: 200,
              background: isActive ? page.border : "transparent",
              color: isActive ? page.fg : page.statusFg,
              borderColor: page.border,
              borderBottom: isActive
                ? `2px solid ${page.fg}`
                : "2px solid transparent",
            }}
          >
            <span className="shrink-0">
              <AgentStatusIcon status={status} size={12} />
            </span>
            <span className="flex-1 truncate text-left">
              {getTabTitle(tab)}
            </span>
            <button
              type="button"
              className="shrink-0 rounded opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 cursor-pointer ml-auto"
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

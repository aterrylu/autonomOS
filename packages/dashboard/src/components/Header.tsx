import { displayChord } from "../shortcuts/chord";
import { SHORTCUTS } from "../shortcuts/registry";
import { THEMES, useStore } from "../store";

// Read from the registry so the tooltip can never drift from the real binding.
const sidebarChord =
  SHORTCUTS.find((s) => s.id === "sidebar.toggle")?.chord ?? "mod+b";

export function Header() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const page = THEMES[theme].page;

  return (
    <header
      className="flex items-center gap-4 px-5 py-3"
      style={{ borderBottom: `1px solid ${page.border}` }}
    >
      <button
        type="button"
        onClick={toggleSidebar}
        className="cursor-pointer text-sm"
        style={{ color: sidebarOpen ? page.fg : page.statusFg }}
        title={`Toggle sidebar (${displayChord(sidebarChord)})`}
      >
        ☰
      </button>
      <h1 className="text-base font-semibold">autonomOS</h1>
    </header>
  );
}

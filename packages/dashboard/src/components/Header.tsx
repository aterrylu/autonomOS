import { THEMES, useStore } from "../store";

export function Header() {
  const theme = useStore((s) => s.theme);
  const status = useStore((s) => s.status);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const autonomousMode = useStore((s) => s.autonomousMode);
  const cycleTheme = useStore((s) => s.cycleTheme);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const toggleAutonomousMode = useStore((s) => s.toggleAutonomousMode);
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
        title="Toggle sidebar"
      >
        ☰
      </button>
      <h1 className="text-base font-semibold">autonomOS</h1>
      <span className="text-sm" style={{ color: page.statusFg }}>
        {status}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={toggleAutonomousMode}
          className="rounded-md px-3 py-1.5 text-sm cursor-pointer"
          style={{
            background: autonomousMode ? "#22863a" : page.border,
            color: autonomousMode ? "#fff" : page.statusFg,
          }}
          title={
            autonomousMode
              ? "Autonomous mode: ON — sessions skip permission prompts"
              : "Autonomous mode: OFF — sessions require permission approval"
          }
        >
          Autonomous
        </button>
        <button
          type="button"
          onClick={cycleTheme}
          className="rounded-md px-4 py-1.5 text-sm cursor-pointer"
          style={{ background: page.border, color: page.fg }}
        >
          {theme[0].toUpperCase() + theme.slice(1)}
        </button>
      </div>
    </header>
  );
}

import { THEMES, useStore } from "../store";

export function Header() {
  const theme = useStore((s) => s.theme);
  const status = useStore((s) => s.status);
  const cycleTheme = useStore((s) => s.cycleTheme);
  const page = THEMES[theme].page;

  return (
    <header
      className="flex items-center gap-4 px-5 py-3"
      style={{ borderBottom: `1px solid ${page.border}` }}
    >
      <h1 className="text-base font-semibold">autonomOS</h1>
      <span className="text-sm" style={{ color: page.statusFg }}>
        {status}
      </span>
      <div className="ml-auto">
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

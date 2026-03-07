import { THEMES, useStore } from "../store";

export function Header() {
  const theme = useStore((s) => s.theme);
  const status = useStore((s) => s.status);
  const cycleTheme = useStore((s) => s.cycleTheme);
  const setStatus = useStore((s) => s.setStatus);
  const setSessionId = useStore((s) => s.setSessionId);
  const page = THEMES[theme].page;

  const isSpawning = status === "spawning...";

  async function createSession() {
    if (isSpawning) return;
    setStatus("spawning...");

    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workingDirectory: "~" }),
    }).catch(() => null);

    if (!res) {
      setStatus("server unreachable");
      return;
    }

    if (!res.ok) {
      setStatus("failed to create session");
      return;
    }

    const session = await res.json();
    setSessionId(session.id);
  }

  return (
    <header
      className="flex items-center gap-4 px-5 py-3"
      style={{ borderBottom: `1px solid ${page.border}` }}
    >
      <h1 className="text-base font-semibold">autonomOS</h1>
      <span className="text-sm" style={{ color: page.statusFg }}>
        {status}
      </span>
      <div className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={cycleTheme}
          className="rounded-md px-4 py-1.5 text-sm cursor-pointer"
          style={{ background: page.border, color: page.fg }}
        >
          {theme[0].toUpperCase() + theme.slice(1)}
        </button>
        <button
          type="button"
          onClick={createSession}
          disabled={isSpawning}
          className="rounded-md bg-[#238636] px-4 py-1.5 text-sm text-white cursor-pointer hover:bg-[#2ea043] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          New Session
        </button>
      </div>
    </header>
  );
}

import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { THEMES, useStore } from "./store";

export function App() {
  const theme = useStore((s) => s.theme);
  const sessionId = useStore((s) => s.sessionId);
  const page = THEMES[theme].page;

  return (
    <div
      className="flex h-screen flex-col font-sans"
      style={{ background: page.bg, color: page.fg }}
    >
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {sessionId ? (
          <TerminalView key={sessionId} />
        ) : (
          <div
            className="flex flex-1 items-center justify-center text-sm"
            style={{ color: page.statusFg }}
          >
            Create or select a session to start
          </div>
        )}
      </div>
    </div>
  );
}

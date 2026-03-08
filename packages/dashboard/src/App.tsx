import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { TerminalView } from "./components/TerminalView";
import { THEMES, useStore } from "./store";

export function App() {
  const theme = useStore((s) => s.theme);
  const sessionId = useStore((s) => s.sessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const page = THEMES[theme].page;

  return (
    <div
      className="flex flex-col font-sans"
      style={{ background: page.bg, color: page.fg, height: "100dvh" }}
    >
      <Header />
      <div className="relative flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
            <div
              className="absolute inset-0 z-10 md:hidden"
              onClick={() => useStore.getState().toggleSidebar()}
            />
            <Sidebar />
          </>
        )}
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

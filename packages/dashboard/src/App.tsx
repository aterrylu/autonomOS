import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { SessionViewManager } from "./components/SessionViewManager";
import { Sidebar } from "./components/Sidebar";
import { THEMES, useStore } from "./store";
import { isMac } from "./utils/platform";

export function App() {
  const theme = useStore((s) => s.theme);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const page = THEMES[theme].page;
  const viewportHeight = useViewportHeight();

  // Cmd/Ctrl+B toggles sidebar (global handler — works even without a terminal)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "b") {
        e.preventDefault();
        useStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      className="flex flex-col font-sans"
      style={{ background: page.bg, color: page.fg, height: viewportHeight }}
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
        <SessionViewManager />
      </div>
    </div>
  );
}

/**
 * Returns a CSS height string that tracks the visual viewport.
 * On mobile, the visual viewport shrinks when the virtual keyboard opens,
 * so this ensures the app resizes to fit above the keyboard.
 * Falls back to "100dvh" on desktop or unsupported browsers.
 */
function useViewportHeight() {
  const [height, setHeight] = useState("100dvh");

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => setHeight(`${vv.height}px`);
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);

  return height;
}

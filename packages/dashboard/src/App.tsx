import { Header } from "./components/Header";
import { TerminalView } from "./components/TerminalView";
import { THEMES, useStore } from "./store";

export function App() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  return (
    <div
      className="flex h-screen flex-col font-sans"
      style={{ background: page.bg, color: page.fg }}
    >
      <Header />
      <TerminalView />
    </div>
  );
}

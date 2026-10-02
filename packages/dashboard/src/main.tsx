import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { useStore } from "./store";
import { getLiveTerminal } from "./terminal/liveTerminals";
import "./index.css";

// Dev-only store bridge: expose the zustand store on window so the Playwright
// L4 e2e suite (which drives the real vite dev server) can read layout/active-
// pane state to verify split-pane + tab flows. Stripped from production builds
// by the `import.meta.env.DEV` guard (Vite dead-code-eliminates the branch).
if (import.meta.env.DEV) {
  (
    window as unknown as { __autonomosStore?: typeof useStore }
  ).__autonomosStore = useStore;
  // Same bridge for the live terminals: the replay e2e reads the xterm grid a
  // reconnect replay produced (terminal-replay.spec.ts).
  (
    window as unknown as { __autonomosTerminal?: typeof getLiveTerminal }
  ).__autonomosTerminal = getLiveTerminal;
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

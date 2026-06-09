import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PreviewPage } from "./PreviewPage";
import { useStore } from "./store";
import "./index.css";

// Dev-only store bridge: expose the zustand store on window so the Playwright
// L4 e2e suite (which drives the real vite dev server) can read layout/active-
// pane state to verify split-pane + tab flows. Stripped from production builds
// by the `import.meta.env.DEV` guard (Vite dead-code-eliminates the branch).
if (import.meta.env.DEV) {
  (
    window as unknown as { __autonomosStore?: typeof useStore }
  ).__autonomosStore = useStore;
}

const isPreview = window.location.pathname.startsWith("/preview");

createRoot(document.getElementById("root")!).render(
  isPreview ? <PreviewPage /> : <App />,
);

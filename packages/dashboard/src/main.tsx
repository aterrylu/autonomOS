import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PreviewPage } from "./PreviewPage";
import "./index.css";

const isPreview = window.location.pathname.startsWith("/preview");

createRoot(document.getElementById("root")!).render(
  isPreview ? <PreviewPage /> : <App />,
);

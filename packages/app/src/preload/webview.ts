// Preload script loaded INSIDE the dashboard <webview>.
//
// CRITICAL: <webview> preloads are loaded via CommonJS `require()` in
// the guest renderer process, regardless of package.json "type": "module".
// This file is built with a dedicated tsconfig.webview-preload.json that
// emits CommonJS, then a build step renames the output to `.cjs` so
// Node/Electron unambiguously load it as CommonJS even though our
// packages/app/package.json says "type": "module".
//
// Wires window-drag bridging: mousedown in dashboard <header>
// → ipcRenderer.sendToHost → host renderer's onIpcMessage → IPC to main
// → BrowserWindow.setPosition (see main/ipc.ts windows:drag-* handlers).

// biome-ignore lint/correctness/noNodejsModules: webview preload uses CJS require
import { ipcRenderer } from "electron";

// biome-ignore lint/suspicious/noConsole: load-time diagnostic
console.log("[autonomos webview preload] loaded");

const INTERACTIVE_SELECTOR = "button, a, input, select, textarea";
const HEADER_SELECTOR = "header.flex.items-center.gap-4";

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null
  );
}

function inDraggableHeader(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(HEADER_SELECTOR) !== null;
}

function init(): void {
  const w = window as Window & { __autonomosDragWired?: boolean };
  if (w.__autonomosDragWired) return;
  w.__autonomosDragWired = true;

  // biome-ignore lint/suspicious/noConsole: load-time diagnostic
  console.log("[autonomos webview preload] init complete, listeners attached");

  let dragging = false;
  let lastSent = 0;

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      const inHeader = inDraggableHeader(e.target);
      const interactive = isInteractive(e.target);
      // biome-ignore lint/suspicious/noConsole: drag diagnostic
      console.log(
        "[preload] mousedown inHeader=",
        inHeader,
        "interactive=",
        interactive,
      );
      if (!inHeader) return;
      if (interactive) return;
      dragging = true;
      lastSent = 0;
      ipcRenderer.sendToHost("drag-start", {
        cursorX: e.screenX,
        cursorY: e.screenY,
      });
    },
    true,
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!dragging) return;
      const now = performance.now();
      if (now - lastSent < 8) return;
      lastSent = now;
      ipcRenderer.sendToHost("drag-move", {
        cursorX: e.screenX,
        cursorY: e.screenY,
      });
    },
    true,
  );

  const end = (): void => {
    if (!dragging) return;
    dragging = false;
    ipcRenderer.sendToHost("drag-end");
  };

  document.addEventListener("mouseup", end, true);
  document.addEventListener("mouseleave", end, true);
  window.addEventListener("blur", end, true);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

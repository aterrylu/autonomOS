// Preload script loaded INSIDE the dashboard <webview>. Separate from
// preload/main.ts which loads in the host BrowserWindow.
//
// Wires up window-drag bridging: mousedown in the dashboard's <header>
// → ipcRenderer.sendToHost → host renderer's onIpcMessage → IPC to main
// → BrowserWindow.setPosition (see main/ipc.ts windows:drag-* handlers).
//
// This file runs in the webview's renderer process WITHOUT
// contextIsolation by default (Electron's webview preload runs in the
// same JS context as the page). We don't expose anything to the page —
// the listeners are document-level and only communicate via the
// ipc-message channel to the host renderer.

import { ipcRenderer } from "electron";

declare global {
  interface Window {
    __autonomosDragWired?: boolean;
  }
}

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
  if (window.__autonomosDragWired) return;
  window.__autonomosDragWired = true;

  let dragging = false;
  let lastSent = 0;

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      if (!inDraggableHeader(e.target)) return;
      if (isInteractive(e.target)) return;
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
      // Throttle to ~120fps; setPosition under that flickers anyway.
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

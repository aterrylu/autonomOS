// Preload script loaded INSIDE the dashboard <webview>.
//
// CRITICAL: <webview> preloads are loaded via CommonJS `require()` in
// the guest renderer process, regardless of package.json "type": "module".
// This file is built with a dedicated tsconfig.webview-preload.json that
// emits CommonJS, then a build step renames the output to `.cjs` so
// Node/Electron unambiguously load it as CommonJS.
//
// Wires window-drag signaling: mousedown in dashboard <header> sends
// "drag-start" to the host; mouseup sends "drag-end". The main process
// polls the cursor independently via screen.getCursorScreenPoint() —
// see main/ipc.ts windows:drag-start handler.
//
// We do NOT forward mousemove or mouseleave events:
//   - mousemove is unused because the main process polls instead.
//   - mouseleave was a bug: during fast drags the cursor exits the
//     webview document, mouseleave fires, drag ends prematurely.
//     Drags should ONLY end on a real mouseup.

import { ipcRenderer } from "electron";

// Mirrored inline in renderer/TitleBar.tsx (separate build target, can't
// share an import) — keep the two in sync.
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

  let dragging = false;

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      if (!inDraggableHeader(e.target)) return;
      if (isInteractive(e.target)) return;
      dragging = true;
      ipcRenderer.sendToHost("drag-start");
    },
    true,
  );

  // mouseup with capture-phase on document → fires even if the cursor
  // moved off the original element (implicit pointer capture during
  // mousedown-held state). This is the primary drag-end signal.
  document.addEventListener(
    "mouseup",
    () => {
      if (!dragging) return;
      dragging = false;
      ipcRenderer.sendToHost("drag-end");
    },
    true,
  );

  // Double-click in the draggable header → zoom, matching native macOS
  // title bars. Same guards as drag-start: header-only, never on
  // interactive elements. The dblclick's own mousedown/mouseup pair has
  // already sent drag-start/drag-end by the time this fires; the host's
  // zoom handler also ends any drag defensively.
  document.addEventListener(
    "dblclick",
    (e) => {
      if (!inDraggableHeader(e.target)) return;
      if (isInteractive(e.target)) return;
      ipcRenderer.sendToHost("zoom");
    },
    true,
  );

  // Blur fallback: if the user alt-tabs away or the window loses focus
  // during a drag for any reason, end the drag so we don't keep polling
  // the cursor and dragging the window forever.
  window.addEventListener("blur", () => {
    if (!dragging) return;
    dragging = false;
    ipcRenderer.sendToHost("drag-end");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

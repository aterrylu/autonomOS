import { useEffect, useRef, useState } from "react";
import type { Connection } from "../types/connection.js";

interface ConnectionWebviewProps {
  connection: Connection;
}

/** CSS injected into the dashboard webview so the macOS traffic lights
 *  visually clear the dashboard's <Header>. NOTE: drag-region CSS does
 *  NOT work here — Chromium does not propagate hit-test regions from a
 *  <webview> guest page to the host BrowserWindow. We bridge dragging
 *  via mousedown → ipc-message → host → startWindowDrag() instead. */
const INTEGRATION_CSS = `
  /* Reserve space for macOS traffic lights at the top-left. */
  header.flex.items-center.gap-4 {
    padding-left: 88px !important;
  }
  /* Suppress text/element selection across the entire header so
   * dragging the window doesn't flash a selection highlight on
   * the hamburger icon, h1, or any other header child. */
  header.flex.items-center.gap-4,
  header.flex.items-center.gap-4 * {
    -webkit-user-select: none !important;
    user-select: none !important;
  }
  /* Buttons explicitly get their pointer cursor back (the broad
   * rule above doesn't change cursor, but spell it out). */
  header.flex.items-center.gap-4 h1 { cursor: default !important; }
  header.flex.items-center.gap-4 button { cursor: pointer !important; }
`;

/** Drag-bridge logic lives in the webview preload script
 *  (preload/webview.ts), wired via the `preload` attribute on the
 *  <webview> below. Earlier approach (webview.executeJavaScript with
 *  inline require('electron')) didn't work because the dashboard page
 *  runs WITHOUT nodeIntegration — require is undefined. A webview
 *  preload script has access to ipcRenderer regardless of the page's
 *  nodeIntegration setting. */

/** Electron's <webview> element type — augmented because React 19's JSX
 *  doesn't ship it by default. */
interface WebviewElement extends HTMLElement {
  src: string;
  partition: string;
  insertCSS(css: string): Promise<string>;
  executeJavaScript(code: string): Promise<unknown>;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface IpcMessageEvent extends Event {
  channel: string;
}

export function ConnectionWebview({
  connection,
}: ConnectionWebviewProps): React.ReactElement {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webviewRef = useRef<WebviewElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await window.autonomos.webview.prepare(connection.id);
      if (cancelled) return;
      if (result.ok) setReady(true);
      else
        setError(
          "Failed to prepare connection (missing token?). Remove and re-add.",
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !ready) return;

    const onDomReady = (): void => {
      void webview.insertCSS(INTEGRATION_CSS);
    };
    const onIpcMessage = (event: Event): void => {
      const msg = event as IpcMessageEvent & {
        args: [{ cursorX: number; cursorY: number } | undefined];
      };
      switch (msg.channel) {
        case "drag-start": {
          const { cursorX = 0, cursorY = 0 } = msg.args?.[0] ?? {};
          window.autonomos.windows.dragStart(cursorX, cursorY);
          break;
        }
        case "drag-move": {
          const { cursorX = 0, cursorY = 0 } = msg.args?.[0] ?? {};
          window.autonomos.windows.dragMove(cursorX, cursorY);
          break;
        }
        case "drag-end": {
          window.autonomos.windows.dragEnd();
          break;
        }
      }
    };

    webview.addEventListener("dom-ready", onDomReady);
    webview.addEventListener("ipc-message", onIpcMessage);
    return () => {
      webview.removeEventListener("dom-ready", onDomReady);
      webview.removeEventListener("ipc-message", onIpcMessage);
    };
  }, [ready]);

  if (error) {
    return (
      <div className="full-bleed-message">
        <div style={{ color: "var(--danger)" }}>{error}</div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="full-bleed-message">Connecting to {connection.name}…</div>
    );
  }

  // Webview preload script that bridges window-drag mousedown/move/up
  // events out via ipcRenderer.sendToHost. Compiled to CommonJS with .cjs
  // extension (build:webview-preload script) because Electron's <webview>
  // preload loader uses require() under the hood and ignores
  // package.json "type": "module".
  const webviewPreload = new URL(
    "../preload/webview.cjs",
    window.location.href,
  ).toString();

  return (
    <webview
      // biome-ignore lint/correctness/useUniqueElementIds: single instance per window
      id="connection-webview"
      ref={webviewRef as unknown as React.Ref<HTMLElement>}
      src={connection.url}
      partition={`persist:connection-${connection.id}`}
      preload={webviewPreload}
      style={{
        flex: 1,
        display: "flex",
        border: 0,
        width: "100%",
        height: "100vh",
      }}
      // @ts-expect-error allowpopups isn't in React's typed JSX but is a real webview attribute
      allowpopups="true"
    />
  );
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          preload?: string;
          allowpopups?: string;
        },
        HTMLElement
      >;
    }
  }
}

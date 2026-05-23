import { useEffect, useRef, useState } from "react";
import type { Connection } from "../types/connection.js";

interface ConnectionWebviewProps {
  connection: Connection;
}

/** CSS injected into the dashboard webview to integrate the traffic
 *  lights with the dashboard's <Header>.
 *
 *  Strategy:
 *    1. Reserve 88px on the left of the header (clears traffic lights).
 *    2. Make the header a window drag region.
 *    3. Exempt only interactive children (button/a/input) — they keep
 *       their clicks. The h1 text "autonomOS" stays draggable.
 *    4. user-select: none on the h1 so mousedown doesn't start a text
 *       selection (which would intercept the drag hit-test). */
const INTEGRATION_CSS = `
  header.flex.items-center.gap-4 {
    padding-left: 88px !important;
    -webkit-app-region: drag !important;
    app-region: drag !important;
  }
  header.flex.items-center.gap-4 h1 {
    -webkit-user-select: none !important;
    user-select: none !important;
    cursor: default !important;
  }
  header.flex.items-center.gap-4 button,
  header.flex.items-center.gap-4 a,
  header.flex.items-center.gap-4 input,
  header.flex.items-center.gap-4 select,
  header.flex.items-center.gap-4 textarea {
    -webkit-app-region: no-drag !important;
    app-region: no-drag !important;
  }
`;

const INTEGRATION_JS = "";

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
      if (INTEGRATION_JS.length > 0) {
        void webview.executeJavaScript(INTEGRATION_JS);
      }
    };
    webview.addEventListener("dom-ready", onDomReady);
    return () => webview.removeEventListener("dom-ready", onDomReady);
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

  return (
    <webview
      // biome-ignore lint/correctness/useUniqueElementIds: single instance per window
      id="connection-webview"
      ref={webviewRef as unknown as React.Ref<HTMLElement>}
      src={connection.url}
      partition={`persist:connection-${connection.id}`}
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
          allowpopups?: string;
        },
        HTMLElement
      >;
    }
  }
}

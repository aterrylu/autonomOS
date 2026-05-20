import { useEffect, useRef, useState } from "react";
import type { Connection } from "../types/connection.js";

interface ConnectionWebviewProps {
  connection: Connection;
}

/** CSS + JS injected into every dashboard load so the macOS traffic lights
 *  integrate cleanly with the dashboard's own sidebar. The dashboard's
 *  `<aside>` (sidebar) extends to the top of the page — we just push its
 *  first child down 38px to clear the lights, and overlay a transparent
 *  drag region across the top 36px so the user can still move the window. */
const INTEGRATION_CSS = `
  /* Push the dashboard's first sidebar item below the traffic-light area */
  aside.absolute.inset-y-0.left-0 > :first-child {
    margin-top: 38px !important;
  }
`;

const INTEGRATION_JS = `
  (() => {
    if (document.getElementById('__autonomos_drag_region')) return;
    const drag = document.createElement('div');
    drag.id = '__autonomos_drag_region';
    drag.style.cssText =
      'position:fixed;top:0;left:0;right:0;height:36px;' +
      '-webkit-app-region:drag;z-index:9999;pointer-events:none;';
    document.body.appendChild(drag);
  })();
`;

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
      void webview.executeJavaScript(INTEGRATION_JS);
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

import { useEffect, useRef, useState } from "react";
import type { Connection } from "../types/connection.js";

interface ConnectionWebviewProps {
  connection: Connection;
}

/** CSS injected into the dashboard webview.
 *
 *  Critical finding from real-use testing: `-webkit-app-region: drag`
 *  does NOT work inside Electron's <webview> tag. The webview runs in an
 *  isolated guest process and Chromium ignores app-region inside it. So
 *  any "make the dashboard header draggable" approach via CSS injection
 *  is fundamentally broken.
 *
 *  Solution: render a draggable title bar in the HOST renderer (outside
 *  the webview), and HIDE the dashboard's own <Header> here so we don't
 *  show two horizontal bars. The host title bar carries the "autonomOS"
 *  branding + connection name and is the one true drag affordance.
 *
 *  The hamburger button (sidebar toggle in the dashboard header) goes
 *  away with this; the dashboard sidebar defaults to open. We can add
 *  a sidebar-toggle action to the host title bar later if needed. */
const INTEGRATION_CSS = `
  /* Hide the dashboard's own header — the host's title bar replaces it
   * with a draggable equivalent (the dashboard header can't be made
   * draggable due to <webview> guest-process isolation). */
  header.flex.items-center.gap-4 {
    display: none !important;
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

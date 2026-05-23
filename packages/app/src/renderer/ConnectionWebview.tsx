import { useEffect, useRef, useState } from "react";
import type { Connection } from "../types/connection.js";

interface ConnectionWebviewProps {
  connection: Connection;
}

/** CSS injected into every dashboard load so the macOS traffic lights
 *  integrate with the dashboard chrome.
 *
 *  The dashboard layout (packages/dashboard/src/App.tsx:261) is:
 *    <Header />        ← top bar with hamburger + "autonomOS" h1
 *    <Sidebar+Content row>
 *    <StatusBar />
 *
 *  Strategy:
 *    1. Push the header's content right of the traffic-light reserve
 *       (88px = 70px lights + 18px breathing) by overriding Tailwind's px-5.
 *    2. Make the entire header element a window drag region — this gives
 *       the user a generous drag affordance for the empty padding area
 *       on the left (between traffic lights and hamburger) AND for the
 *       h1 text on the right.
 *    3. Exempt interactive children (buttons, links, inputs) from the
 *       drag region so they still receive clicks. This is the canonical
 *       Electron + macOS pattern.
 *
 *  Lesson from the previous iteration: `pointer-events: none` on a fixed
 *  div with `-webkit-app-region: drag` does NOT work — Electron's hit
 *  testing for window drag also needs pointer events. The fix is to
 *  attach drag-region to the actual interactive element (the header)
 *  and exempt only the clickable children. */
const INTEGRATION_CSS = `
  /* Reserve space for the macOS traffic-light buttons and make the
   * header a window drag region (so users can move the window from
   * any empty area in the top bar). */
  header.flex.items-center.gap-4 {
    padding-left: 88px !important;
    -webkit-app-region: drag !important;
    app-region: drag !important;
  }
  /* Interactive header children stay clickable; exempt them from drag. */
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

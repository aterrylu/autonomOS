import { useEffect, useState } from "react";
import type { Connection } from "../types/connection.js";

interface ConnectionWebviewProps {
  connection: Connection;
}

/** Renders the connection's dashboard inside an Electron `<webview>` tag.
 *  Before mounting, we ask main to set the autonomos_token cookie on the
 *  per-connection partition session (see ipc.ts `connections:prepare-webview`).
 *  The webview tag is deprecated by Chromium but still supported by
 *  Electron 35; migration to WebContentsView is a follow-up. */
export function ConnectionWebview({
  connection,
}: ConnectionWebviewProps): React.ReactElement {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await window.autonomos.webview.prepare(connection.id);
      if (cancelled) return;
      if (result.ok) {
        setReady(true);
      } else {
        setError(
          "Failed to prepare connection (missing token?). Try removing and re-adding.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  if (error) {
    return (
      <div className="connected">
        <div
          style={{ color: "var(--danger)", textAlign: "center", maxWidth: 420 }}
        >
          {error}
        </div>
      </div>
    );
  }

  if (!ready) {
    return <div className="connected">Connecting to {connection.name}…</div>;
  }

  // biome-ignore lint/security/noDangerouslySetInnerHtml: <webview> tag needs to be raw
  return (
    <webview
      // biome-ignore lint/correctness/useUniqueElementIds: single instance per render
      id="connection-webview"
      src={connection.url}
      partition={`persist:connection-${connection.id}`}
      style={{ flex: 1, display: "flex", border: 0 }}
      // @ts-expect-error — `allowpopups` isn't in React's typed JSX, but is a real webview attribute
      allowpopups="true"
    />
  );
}

// React 19 doesn't have <webview> in its built-in types. Augment so TSX
// compiles cleanly. Only the attributes we actually use are typed.
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

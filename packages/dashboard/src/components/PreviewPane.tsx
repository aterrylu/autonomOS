import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PreviewPaneInfo } from "../store";
import { THEMES, useStore } from "../store";
import { Codicon } from "./Codicon";

mermaid.initialize({ startOnLoad: false, theme: "dark" });

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;

function MermaidBlock({ children }: { children: string }) {
  const id = useId().replace(/:/g, "_");
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    mermaid.render(`mermaid${id}`, children.trim()).then((result) => {
      if (!cancelled) setSvg(DOMPurify.sanitize(result.svg));
    });
    return () => {
      cancelled = true;
    };
  }, [children, id]);

  if (!svg) return null;

  // Mermaid output is sanitized through DOMPurify above
  return (
    <div
      className="my-4 flex justify-center"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG sanitized via DOMPurify
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

interface PreviewPaneProps {
  preview: PreviewPaneInfo;
  visible: boolean;
}

export const PreviewPane = memo(function PreviewPane({
  preview,
  visible,
}: PreviewPaneProps) {
  const theme = useStore((s) => s.theme);
  const closePreview = useStore((s) => s.closePreview);
  const page = THEMES[theme].page;

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Initial fetch
  useEffect(() => {
    fetch(`/api/files/read?path=${encodeURIComponent(preview.filePath)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message));
  }, [preview.filePath]);

  // Live updates via WebSocket file watcher
  useEffect(() => {
    const ws = new WebSocket(
      `${WS_URL}/ws/files/watch?path=${encodeURIComponent(preview.filePath)}`,
    );

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "update" && typeof msg.content === "string") {
          setContent(msg.content);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [preview.filePath]);

  const previewUrl = `/preview?file=${encodeURIComponent(preview.filePath)}`;

  function handleShareExternal() {
    window.open(previewUrl, "_blank", "noopener");
  }

  function handleCopyLink() {
    const fullUrl = `${location.origin}${previewUrl}`;
    navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const components: Components = {
    code: useCallback(
      ({
        className,
        children,
        ...props
      }: React.ComponentProps<"code"> & { className?: string }) => {
        if (className === "language-mermaid" && typeof children === "string") {
          return <MermaidBlock>{children}</MermaidBlock>;
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      },
      [],
    ),
  };

  return (
    <div
      className="flex flex-1 flex-col"
      style={{ display: visible ? "flex" : "none" }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-3 shrink-0"
        style={{
          height: 32,
          borderBottom: `1px solid ${page.border}`,
          color: page.statusFg,
        }}
      >
        <Codicon name="markdown" size={14} />
        <span className="flex-1 truncate text-xs ml-1" title={preview.filePath}>
          {preview.title}
        </span>

        {/* Copy link */}
        <button
          type="button"
          onClick={handleCopyLink}
          className="shrink-0 rounded p-1 cursor-pointer hover:opacity-80"
          title="Copy preview link"
        >
          {copied ? (
            <span className="text-[10px]" style={{ color: "#91b362" }}>
              Copied!
            </span>
          ) : (
            <Codicon name="copy" size={14} />
          )}
        </button>

        {/* Open external */}
        <button
          type="button"
          onClick={handleShareExternal}
          className="shrink-0 rounded p-1 cursor-pointer hover:opacity-80"
          title="Open in new tab"
        >
          <Codicon name="link-external" size={14} />
        </button>

        {/* Close */}
        <button
          type="button"
          onClick={() => closePreview(preview.id)}
          className="shrink-0 rounded p-1 cursor-pointer hover:opacity-80"
          title="Close preview"
        >
          <Codicon name="close" size={14} />
        </button>
      </div>

      {/* Content */}
      <div
        className="flex-1 overflow-y-auto px-8 py-6"
        style={{ color: page.fg }}
      >
        {error && (
          <div className="text-sm" style={{ color: "#ea6c73" }}>
            Failed to load file: {error}
          </div>
        )}
        {content === null && !error && (
          <div className="text-sm" style={{ color: page.statusFg }}>
            Loading...
          </div>
        )}
        {content !== null && (
          <article className="prose-custom mx-auto max-w-3xl">
            <Markdown remarkPlugins={[remarkGfm]} components={components}>
              {content}
            </Markdown>
          </article>
        )}
      </div>
    </div>
  );
});

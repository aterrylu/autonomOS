import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { useCallback, useEffect, useId, useState } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { THEMES, useStore } from "./store";

mermaid.initialize({ startOnLoad: false, theme: "dark" });

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

  return (
    <div
      className="my-4 flex justify-center"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG sanitized via DOMPurify
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function PreviewPage() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const filePath = new URLSearchParams(window.location.search).get("file");
  const fileName = filePath?.split("/").pop() ?? "";

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = fileName ? `${fileName} — autonomOS` : "autonomOS";
    return () => {
      document.title = "autonomOS";
    };
  }, [fileName]);

  useEffect(() => {
    if (!filePath) return;
    fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message));
  }, [filePath]);

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

  if (!filePath) {
    return (
      <div
        className="flex h-screen items-center justify-center font-sans"
        style={{ background: page.bg, color: page.statusFg }}
      >
        No file specified. Use ?file=/path/to/file.md
      </div>
    );
  }

  return (
    <div
      className="flex h-screen flex-col font-sans"
      style={{ background: page.bg, color: page.fg }}
    >
      <header
        className="flex items-center gap-2 px-4 py-2 text-xs shrink-0"
        style={{
          borderBottom: `1px solid ${page.border}`,
          color: page.statusFg,
        }}
      >
        <span className="truncate">{filePath}</span>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-6">
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
      </main>
    </div>
  );
}

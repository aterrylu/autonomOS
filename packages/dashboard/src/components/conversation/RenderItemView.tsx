import type { RenderItem } from "@autonomos/core";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { THEMES, useStore } from "../../store";
import { DiffBlock } from "./DiffView";

interface RenderItemViewProps {
  item: RenderItem;
}

export function RenderItemView({ item }: RenderItemViewProps) {
  switch (item.type) {
    case "text":
      return <MarkdownContent content={item.content} />;
    case "user_prompt":
      return <MarkdownContent content={item.content} />;
    case "system":
      return (
        <span className="text-xs italic opacity-50">[{item.subtype}]</span>
      );
    default:
      return null;
  }
}

function MarkdownContent({ content }: { content: string }) {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;

  const codeBg = theme === "daylight" ? "#e8e8e6" : `${page.border}cc`;

  return (
    <div className="prose-custom">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Inline code & fenced code blocks
          code({ children, className }) {
            const isDiff = className === "language-diff";
            const isBlock = className?.startsWith("language-");

            if (isDiff) {
              return (
                <DiffBlock content={extractText(children)} />
              );
            }
            if (isBlock) {
              return (
                <code
                  className="block whitespace-pre-wrap font-mono text-[12px] rounded-lg p-3 overflow-x-auto"
                  style={{ background: codeBg, color: page.fg }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="font-mono text-[12px] rounded px-1.5 py-0.5"
                style={{ background: codeBg, color: page.fg }}
              >
                {children}
              </code>
            );
          },
          // Code blocks
          pre({ children }) {
            return (
              <pre
                className="rounded-lg overflow-hidden my-2"
                style={{ background: codeBg }}
              >
                {children}
              </pre>
            );
          },
          // Paragraphs — no extra margin for single-paragraph content
          p({ children }) {
            return <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>;
          },
          // Lists
          ul({ children }) {
            return <ul className="my-1.5 pl-5 list-disc">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1.5 pl-5 list-decimal">{children}</ol>;
          },
          li({ children }) {
            return <li className="my-0.5">{children}</li>;
          },
          // Bold
          strong({ children }) {
            return <strong className="font-semibold">{children}</strong>;
          },
          // Links
          a({ children, href }) {
            return (
              <a
                href={href}
                className="underline underline-offset-2"
                style={{ color: theme === "daylight" ? "#0366d6" : "#53bdfa" }}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          // Blockquotes
          blockquote({ children }) {
            return (
              <blockquote
                className="my-2 pl-3"
                style={{
                  borderLeft: `3px solid ${page.border}`,
                  color: page.statusFg,
                }}
              >
                {children}
              </blockquote>
            );
          },
          // Headings
          h1({ children }) {
            return <h1 className="text-lg font-bold mt-3 mb-1.5">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-base font-bold mt-3 mb-1">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-sm font-bold mt-2 mb-1">{children}</h3>;
          },
          // Horizontal rule
          hr() {
            return (
              <hr
                className="my-3 border-none h-px"
                style={{ background: page.border }}
              />
            );
          },
          // Tables
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table
                  className="text-xs border-collapse w-full"
                  style={{ borderColor: page.border }}
                >
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th
                className="text-left font-semibold px-2 py-1.5 text-xs"
                style={{
                  borderBottom: `2px solid ${page.border}`,
                  color: page.fg,
                }}
              >
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td
                className="px-2 py-1.5 text-xs"
                style={{ borderBottom: `1px solid ${page.border}` }}
              >
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

/** Extract plain text from React children (for passing to DiffBlock) */
function extractText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (
    children &&
    typeof children === "object" &&
    "props" in children &&
    (children as { props?: { children?: ReactNode } }).props?.children
  ) {
    return extractText(
      (children as { props: { children: ReactNode } }).props.children,
    );
  }
  return String(children ?? "");
}

import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * MarkdownText component for assistant-ui Thread.
 * Uses react-markdown directly instead of @assistant-ui/react-markdown
 * to avoid SmoothContextProvider/AuiProvider dependency issues.
 */
const MarkdownTextImpl = ({ text: textProp }: { text?: string }) => {
  const text = textProp ?? "";

  if (!text) return null;

  return (
    <div className="aui-md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </Markdown>
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const markdownComponents = {
  h1: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className={cn("aui-md-h1 mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0", className)} {...props} />
  ),
  h2: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className={cn("aui-md-h2 mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0", className)} {...props} />
  ),
  h3: ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className={cn("aui-md-h3 mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0", className)} {...props} />
  ),
  p: ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className={cn("aui-md-p my-2.5 leading-normal first:mt-0 last:mb-0", className)} {...props} />
  ),
  a: ({ className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className={cn("aui-md-a text-primary underline underline-offset-2", className)} target="_blank" rel="noopener noreferrer" {...props} />
  ),
  blockquote: ({ className, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className={cn("aui-md-blockquote my-2.5 border-muted-foreground/30 border-l-2 pl-3 text-muted-foreground italic", className)} {...props} />
  ),
  ul: ({ className, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className={cn("aui-md-ul my-2 ml-4 list-disc marker:text-muted-foreground [&>li]:mt-1", className)} {...props} />
  ),
  ol: ({ className, ...props }: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className={cn("aui-md-ol my-2 ml-4 list-decimal marker:text-muted-foreground [&>li]:mt-1", className)} {...props} />
  ),
  li: ({ className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className={cn("aui-md-li leading-normal", className)} {...props} />
  ),
  hr: ({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) => (
    <hr className={cn("aui-md-hr my-2 border-muted-foreground/20", className)} {...props} />
  ),
  pre: ({ className, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre className={cn("aui-md-pre overflow-x-auto rounded-lg border border-border/50 bg-muted/30 p-3 text-xs leading-relaxed my-2", className)} {...props} />
  ),
  code: ({ className, ...props }: React.HTMLAttributes<HTMLElement>) => {
    const isBlock = className?.startsWith("language-");
    return (
      <code
        className={cn(
          !isBlock && "aui-md-inline-code rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
  table: ({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) => (
    <table className={cn("aui-md-table my-2 w-full border-separate border-spacing-0 overflow-y-auto", className)} {...props} />
  ),
  th: ({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className={cn("aui-md-th bg-muted px-2 py-1 text-left font-medium", className)} {...props} />
  ),
  td: ({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className={cn("aui-md-td border-muted-foreground/20 border-b border-l px-2 py-1 text-left last:border-r", className)} {...props} />
  ),
};

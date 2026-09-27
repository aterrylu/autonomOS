/**
 * A deliberately tiny markdown → React renderer for GitHub release bodies.
 *
 * SECURITY: release bodies are UNTRUSTED input (anyone who can publish a
 * release — or a compromised token — controls them). This renderer builds
 * React elements only; there is no dangerouslySetInnerHTML / innerHTML
 * anywhere on the path, so raw HTML in a body (`<script>`, `<img onerror>`)
 * lands as literal escaped text. Links become anchors ONLY for http(s) URLs;
 * any other scheme (javascript:, data:, vbscript:, relative) renders as plain
 * text. No dependency was added for this: a markdown library would bring a
 * far larger surface (raw-HTML passthrough is on by default in most) than the
 * subset our release notes actually use.
 *
 * Supported subset: # / ## / ### headings (#### and deeper render as ###),
 * paragraphs, "- " / "* " bullets, "1. " numbered items, ``` fences
 * (literal), `---` rules, **bold**, `code`, [text](url), and bare
 * http(s) URLs. HTML comments are dropped (GitHub hides them too).
 */

import { Fragment, type ReactNode } from "react";

/** The href to use for `raw`, or null when it must NOT become a link. */
export function safeHref(raw: string): string | null {
  let url: URL;
  try {
    // No base: relative URLs throw and so never become links.
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.href
    : null;
}

// Order matters: code spans first (their content is literal), then links
// (their text may contain bold), then bold, then bare URLs.
// A SOURCE, not a shared /g RegExp: renderInline recurses (bold/link text),
// and a shared instance's lastIndex would be reset under the outer loop.
const INLINE_SRC =
  /(`[^`\n]+`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^\n]+?)\*\*|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/
    .source;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const re = new RegExp(INLINE_SRC, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    const [whole, code, linkText, linkUrl, bold, bare] = m;
    if (code !== undefined) {
      out.push(
        <code
          key={key}
          className="rounded px-1 font-mono"
          style={{ background: "rgba(127,127,127,0.18)", fontSize: "0.92em" }}
        >
          {code.slice(1, -1)}
        </code>,
      );
    } else if (linkText !== undefined && linkUrl !== undefined) {
      const href = safeHref(linkUrl);
      const inner = renderInline(linkText, key);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
            style={{ color: "var(--notes-link, #58a6ff)" }}
          >
            {inner}
          </a>
        ) : (
          // Unsafe scheme: keep the WHOLE source as text so the reader sees
          // exactly what the notes contained — never a clickable anchor.
          <span key={key}>{whole}</span>
        ),
      );
    } else if (bold !== undefined) {
      out.push(
        <strong key={key} className="font-semibold">
          {renderInline(bold, key)}
        </strong>,
      );
    } else if (bare !== undefined) {
      const href = safeHref(bare);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all"
            style={{ color: "var(--notes-link, #58a6ff)" }}
          >
            {bare}
          </a>
        ) : (
          bare
        ),
      );
    }
    last = m.index + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "para"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" }
  | { kind: "code"; text: string };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseBlocks(src: string): Block[] {
  // HTML comments are invisible on GitHub (our storage-format marker is
  // one) — drop them rather than print them. Removing text is always safe;
  // every other bit of raw HTML still renders literally.
  const lines = src
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    // GitHub renders release bodies like comments: a newline inside a
    // paragraph is a line break, not a space. Keep the lines so the in-app
    // notes read the same as the release page.
    if (para.length) blocks.push({ kind: "para", lines: [...para] });
    para = [];
    if (list) blocks.push({ kind: "list", ...list });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) {
        body.push(lines[i]);
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: h[2] });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const b = BULLET.exec(line);
    const o = b ? null : ORDERED.exec(line);
    if (b || o) {
      const ordered = !b;
      if (para.length || (list && list.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push((b ?? o)?.[1] ?? "");
      continue;
    }
    // A non-marker line directly under a list item continues that item
    // (GitHub wraps long bullets); otherwise it joins the paragraph.
    if (list) {
      const items = list.items;
      items[items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: "text-base font-semibold mt-3 mb-1.5",
  2: "text-sm font-semibold mt-3 mb-1.5",
  3: "text-xs font-semibold uppercase tracking-wide mt-3 mb-1",
};

/** Render an untrusted release body. Returns React nodes — never HTML. */
export function ReleaseMarkdown({ body }: { body: string }) {
  const blocks = parseBlocks(body);
  return (
    <div className="text-xs leading-relaxed" data-testid="release-markdown">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case "heading": {
            const Tag = (["h3", "h4", "h5"] as const)[b.level - 1];
            return (
              <Tag key={key} className={`${HEADING_CLASS[b.level]} first:mt-0`}>
                {renderInline(b.text, key)}
              </Tag>
            );
          }
          case "para":
            return (
              <p key={key} className="my-1.5">
                {b.lines.map((line, j) => {
                  const lk = `${key}-l${j}`;
                  return (
                    <Fragment key={lk}>
                      {j > 0 && <br />}
                      {renderInline(line, lk)}
                    </Fragment>
                  );
                })}
              </p>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag
                key={key}
                className={`my-1.5 pl-5 space-y-1 ${b.ordered ? "list-decimal" : "list-disc"}`}
              >
                {b.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static parse output, never reordered
                  <li key={`${key}-${j}`}>
                    {renderInline(item, `${key}-${j}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "rule":
            return (
              <hr
                key={key}
                className="my-3"
                style={{ borderColor: "rgba(127,127,127,0.3)" }}
              />
            );
          case "code":
            return (
              <pre
                key={key}
                className="my-2 overflow-x-auto rounded p-2 font-mono"
                style={{ background: "rgba(127,127,127,0.14)" }}
              >
                {b.text}
              </pre>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

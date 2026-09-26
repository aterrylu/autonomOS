// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../test/setup-dom";
import { parseBlocks, ReleaseMarkdown, safeHref } from "./releaseMarkdown";

/**
 * The release-notes renderer takes UNTRUSTED GitHub markdown. The XSS cases
 * are the point of this file: raw HTML must land as literal text, and only
 * http(s) links may become anchors.
 */

function renderMd(body: string): HTMLElement {
  const { container } = render(<ReleaseMarkdown body={body} />);
  return container;
}

describe("ReleaseMarkdown — supported subset", () => {
  it("renders headings, paragraphs, bullets, bold, code, links and rules", () => {
    const c = renderMd(
      [
        "# Title",
        "## Section",
        "### Sub",
        "",
        "A paragraph with **bold** and `code` and [a link](https://example.com/x).",
        "",
        "- first",
        "- second with **bold**",
        "",
        "---",
        "",
        "1. one",
        "2. two",
      ].join("\n"),
    );
    expect(c.querySelector("h3")?.textContent).toBe("Title");
    expect(c.querySelector("h4")?.textContent).toBe("Section");
    expect(c.querySelector("h5")?.textContent).toBe("Sub");
    expect(c.querySelector("strong")?.textContent).toBe("bold");
    expect(c.querySelector("code")?.textContent).toBe("code");
    const a = c.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/x");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
    expect(c.querySelectorAll("ol > li")).toHaveLength(2);
    expect(c.querySelector("hr")).not.toBeNull();
  });

  it("links bare https URLs (GitHub's auto-generated PR links)", () => {
    const c = renderMd("See https://github.com/o/r/pull/12.");
    const a = c.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    // Trailing sentence punctuation stays outside the link.
    expect(c.textContent).toBe("See https://github.com/o/r/pull/12.");
  });

  it("keeps code-span contents literal (no bold/link parsing inside)", () => {
    const c = renderMd("`**not bold** [x](https://e.com)`");
    expect(c.querySelector("strong")).toBeNull();
    expect(c.querySelector("a")).toBeNull();
    expect(c.querySelector("code")?.textContent).toBe(
      "**not bold** [x](https://e.com)",
    );
  });

  it("folds a wrapped continuation line into the bullet above it", () => {
    const blocks = parseBlocks("- a long bullet\n  that wraps\n- next");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: ["a long bullet that wraps", "next"],
      },
    ]);
  });
});

describe("ReleaseMarkdown — HTML comments", () => {
  it("drops HTML comments (GitHub hides them; our storage marker is one)", () => {
    const c = renderMd(
      "Intro\n<!-- autonomos:storage-format-change -->\n\n- item <!-- hidden --> end",
    );
    expect(c.textContent).not.toContain("autonomos:storage-format-change");
    expect(c.textContent).not.toContain("<!--");
    expect(c.querySelector("li")?.textContent).toBe("item  end");
  });
});

describe("ReleaseMarkdown — XSS", () => {
  it("renders <script> as literal text, never as an element", () => {
    const c = renderMd("<script>alert(1)</script>");
    expect(c.querySelector("script")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders <img onerror> as literal text", () => {
    const c = renderMd('<img src=x onerror="alert(1)">');
    expect(c.querySelector("img")).toBeNull();
    expect(c.innerHTML).not.toContain("<img");
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("never turns a javascript: link into an anchor", () => {
    const c = renderMd("[x](javascript:alert(1))");
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain("[x](javascript:alert(1)");
  });

  it("never turns a data: or relative link into an anchor", () => {
    const c = renderMd(
      "[d](data:text/html,<b>hi</b>) and [r](/relative/path) and [v](vbscript:x)",
    );
    expect(c.querySelector("a")).toBeNull();
  });

  it("does not let a raw-HTML anchor through either", () => {
    const c = renderMd('<a href="javascript:alert(1)">click</a>');
    expect(c.querySelector("a")).toBeNull();
    expect(c.textContent).toContain('<a href="javascript:alert(1)">click</a>');
  });
});

describe("safeHref", () => {
  it("accepts only http(s)", () => {
    expect(safeHref("https://a.b/c")).toBe("https://a.b/c");
    expect(safeHref("http://a.b/")).toBe("http://a.b/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("//evil.example/x")).toBeNull();
  });
  it("keeps a newline inside a paragraph as a line break, like GitHub", () => {
    const { container } = render(
      <ReleaseMarkdown
        body={"**Install:** one\n**Download:** two\n\nNext para"}
      />,
    );
    const paras = container.querySelectorAll("p");
    expect(paras).toHaveLength(2);
    expect(paras[0].querySelectorAll("br")).toHaveLength(1);
    expect(paras[0].textContent).toBe("Install: oneDownload: two");
  });
});

import { describe, expect, it } from "vitest";

// Extract the URL regex pattern used by UrlLinkProvider for direct testing.
// This is the same regex from terminal/liveTerminals.ts — kept in sync manually.
const URL_PATTERN = /https?:\/\/[^\s"'`<>)\]},;]+[^\s"'`<>)\]},;.:!?]/g;

/** Helper: extract all URL matches from a string */
function findUrls(text: string): string[] {
  URL_PATTERN.lastIndex = 0;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: test helper
  while ((match = URL_PATTERN.exec(text)) !== null) {
    results.push(match[0]);
  }
  URL_PATTERN.lastIndex = 0;
  return results;
}

describe("UrlLinkProvider regex", () => {
  describe("standard URLs", () => {
    it("matches https URLs", () => {
      expect(findUrls("visit https://example.com today")).toEqual([
        "https://example.com",
      ]);
    });

    it("matches http URLs", () => {
      expect(findUrls("see http://example.com/page")).toEqual([
        "http://example.com/page",
      ]);
    });

    it("matches URLs with paths", () => {
      expect(findUrls("https://github.com/org/repo/pull/42")).toEqual([
        "https://github.com/org/repo/pull/42",
      ]);
    });

    it("matches URLs with query params", () => {
      expect(findUrls("https://example.com?a=1&b=2")).toEqual([
        "https://example.com?a=1&b=2",
      ]);
    });

    it("matches URLs with fragments", () => {
      expect(findUrls("https://example.com/page#section")).toEqual([
        "https://example.com/page#section",
      ]);
    });

    it("matches URLs with ports", () => {
      expect(findUrls("http://localhost:3000/api")).toEqual([
        "http://localhost:3000/api",
      ]);
    });

    it("matches URLs with auth", () => {
      expect(findUrls("https://user:pass@host.com/path")).toEqual([
        "https://user:pass@host.com/path",
      ]);
    });
  });

  describe("trailing punctuation stripping", () => {
    it("strips trailing period", () => {
      expect(findUrls("Visit https://example.com.")).toEqual([
        "https://example.com",
      ]);
    });

    it("strips trailing comma", () => {
      expect(findUrls("See https://example.com, then")).toEqual([
        "https://example.com",
      ]);
    });

    it("strips trailing exclamation", () => {
      expect(findUrls("Check https://example.com!")).toEqual([
        "https://example.com",
      ]);
    });

    it("strips trailing question mark", () => {
      expect(findUrls("Is it https://example.com?")).toEqual([
        "https://example.com",
      ]);
    });

    it("strips trailing colon", () => {
      expect(findUrls("URL: https://example.com:")).toEqual([
        "https://example.com",
      ]);
    });

    it("strips trailing closing paren", () => {
      expect(findUrls("(https://example.com)")).toEqual([
        "https://example.com",
      ]);
    });

    it("strips trailing closing bracket", () => {
      expect(findUrls("[https://example.com]")).toEqual([
        "https://example.com",
      ]);
    });
  });

  describe("multiple URLs", () => {
    it("finds multiple URLs on one line", () => {
      expect(findUrls("see https://a.com and https://b.com/path")).toEqual([
        "https://a.com",
        "https://b.com/path",
      ]);
    });

    it("handles URLs separated by commas", () => {
      expect(findUrls("https://a.com, https://b.com")).toEqual([
        "https://a.com",
        "https://b.com",
      ]);
    });
  });

  describe("non-matches", () => {
    it("does not match ftp URLs", () => {
      expect(findUrls("ftp://files.example.com")).toEqual([]);
    });

    it("does not match bare domains", () => {
      expect(findUrls("visit example.com")).toEqual([]);
    });

    it("returns empty for lines without URLs", () => {
      expect(findUrls("no links here")).toEqual([]);
    });

    it("returns empty for empty string", () => {
      expect(findUrls("")).toEqual([]);
    });
  });

  describe("URLs in context", () => {
    it("handles URL in quotes", () => {
      expect(findUrls('"https://example.com"')).toEqual([
        "https://example.com",
      ]);
    });

    it("handles URL in backticks", () => {
      expect(findUrls("`https://example.com`")).toEqual([
        "https://example.com",
      ]);
    });

    it("handles URL in angle brackets", () => {
      expect(findUrls("<https://example.com>")).toEqual([
        "https://example.com",
      ]);
    });

    it("handles URL in markdown link", () => {
      const urls = findUrls("[click here](https://example.com/page)");
      expect(urls).toEqual(["https://example.com/page"]);
    });
  });

  describe("lastIndex reset", () => {
    it("works correctly across multiple calls", () => {
      // Simulates what happens when provideLinks is called multiple times
      expect(findUrls("https://first.com")).toEqual(["https://first.com"]);
      expect(findUrls("https://second.com")).toEqual(["https://second.com"]);
      expect(findUrls("no urls")).toEqual([]);
      expect(findUrls("https://third.com")).toEqual(["https://third.com"]);
    });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deduplicatedOpen } from "./deduplicatedOpen";

// A terminal hyperlink (OSC 8) is attacker-influenceable — an agent's output can
// emit any scheme with benign link text. deduplicatedOpen is the single
// chokepoint both link paths route through, so it enforces a scheme allowlist.

describe("deduplicatedOpen — scheme allowlist", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  // Each test below uses distinct URLs, so the 500ms same-URL dedup never
  // suppresses a call — no clock manipulation needed.

  it("opens allowed schemes (http, https, mailto)", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    deduplicatedOpen("https://example.com/x");
    deduplicatedOpen("http://example.com/y");
    deduplicatedOpen("mailto:a@b.com");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("refuses dangerous / unexpected schemes", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "customapp://do-thing",
    ]) {
      deduplicatedOpen(url);
    }
    expect(open).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("refuses a non-URL / relative value rather than passing garbage to window.open", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deduplicatedOpen("not a url");
    deduplicatedOpen("/relative/path");
    expect(open).not.toHaveBeenCalled();
  });
});

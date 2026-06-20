// @vitest-environment jsdom
// Must come first: the shared jsdom setup stubs HTMLCanvasElement.getContext
// before xterm's WebGL addon probes the canvas at import time (jsdom has no
// canvas backend). Import it ahead of ./xterm-backend so the stub is installed
// first.
import "../test/setup-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard, createXtermBackend } from "./xterm-backend";

/**
 * Tests for OSC 52 clipboard handling, including the insecure-context fallback.
 *
 * Background: Claude Code emits OSC 52 (`ESC ]52;c;<base64> BEL`) to auto-copy
 * the user's terminal selection. xterm.js has no default OSC 52 handler, so
 * `xterm-backend.ts` registers one that decodes the payload and copies it.
 *
 * The original handler used `navigator.clipboard.writeText` unconditionally.
 * `navigator.clipboard` only exists in a *secure context* (HTTPS, or the
 * localhost exception). When autonomOS is served over plain HTTP from a remote
 * host, `navigator.clipboard` is `undefined` and the bare property access threw
 * synchronously — silently breaking remote auto-copy. These tests pin the
 * secure path, the insecure `execCommand` fallback, the anti-exfiltration
 * read-drop, and multi-byte round-tripping.
 *
 * Runs in jsdom (annotation above) because the fallback needs a real `document`.
 */

const options = {
  cursorBlink: false,
  fontSize: 14,
  fontFamily: "monospace",
  scrollback: 1000,
};

function setClipboard(
  value: { writeText: (t: string) => Promise<void> } | undefined,
) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

// jsdom does not implement document.execCommand, so vi.spyOn can't wrap a
// missing property — assign the stub directly and remove it afterwards.
function stubExecCommand(impl: (cmd: string) => boolean) {
  const fn = vi.fn(impl);
  Object.defineProperty(document, "execCommand", {
    value: fn,
    configurable: true,
  });
  return fn;
}

function clearExecCommand() {
  Object.defineProperty(document, "execCommand", {
    value: undefined,
    configurable: true,
  });
}

function osc52(payloadBase64: string): string {
  return `\x1b]52;c;${payloadBase64}\x07`;
}

// btoa operates on Latin1; encode UTF-8 bytes first so multi-byte text survives.
function toBase64Utf8(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

// xterm's WriteBuffer processes chunks asynchronously via setTimeout.
function waitForParse(): Promise<void> {
  return new Promise((r) => setTimeout(r, 50));
}

describe("copyTextToClipboard — secure vs insecure context", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setClipboard(undefined);
    clearExecCommand();
  });

  it("uses navigator.clipboard.writeText in a secure context", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const exec = stubExecCommand(() => true);

    copyTextToClipboard("hello world");

    expect(writeText).toHaveBeenCalledWith("hello world");
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves true when the Clipboard API write succeeds", async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await expect(copyTextToClipboard("ok")).resolves.toBe(true);
  });

  it("resolves to the execCommand result in an insecure context", async () => {
    setClipboard(undefined);
    stubExecCommand(() => true);
    await expect(copyTextToClipboard("a")).resolves.toBe(true);
    stubExecCommand(() => false);
    await expect(copyTextToClipboard("b")).resolves.toBe(false);
  });

  it("falls back to execCommand('copy') when navigator.clipboard is undefined (insecure context)", () => {
    setClipboard(undefined); // plain HTTP on a remote host

    let copied: string | undefined;
    const exec = stubExecCommand((cmd) => {
      if (cmd === "copy") {
        copied = (document.activeElement as HTMLTextAreaElement)?.value;
      }
      return true;
    });

    // The crux: the old code threw a synchronous TypeError here. It must not.
    expect(() => copyTextToClipboard("remote text")).not.toThrow();

    expect(exec).toHaveBeenCalledWith("copy");
    expect(copied).toBe("remote text");
    // The transient textarea is cleaned up afterwards.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand when writeText rejects (secure context, no transient activation)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    setClipboard({ writeText });
    const exec = stubExecCommand(() => true);

    copyTextToClipboard("fallback text");
    // Let the rejected promise's .catch microtask run.
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("fallback text");
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("warns (without throwing) in an insecure context when execCommand also fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setClipboard(undefined);
    stubExecCommand(() => false); // legacy fallback also refuses

    expect(() => copyTextToClipboard("doomed")).not.toThrow();

    expect(warn).toHaveBeenCalled();
  });

  it("warns when the Clipboard API rejects AND execCommand fails (both mechanisms dead)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    setClipboard({ writeText });
    stubExecCommand(() => false);

    copyTextToClipboard("doomed");
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalled();
  });

  it("does NOT warn when execCommand succeeds in an insecure context", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setClipboard(undefined);
    stubExecCommand(() => true);

    copyTextToClipboard("ok");

    expect(warn).not.toHaveBeenCalled();
  });

  it("restores focus to the previously focused element after the fallback", () => {
    setClipboard(undefined);
    stubExecCommand(() => true);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    copyTextToClipboard("x");

    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe("createXtermBackend — OSC 52 handler", () => {
  beforeEach(() => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setClipboard(undefined);
  });

  it("decodes an OSC 52 write and copies the payload to the clipboard", async () => {
    const { terminal } = createXtermBackend(options);
    terminal.write(osc52(btoa("copied via osc52")));
    await waitForParse();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "copied via osc52",
    );
    terminal.dispose();
  });

  it("invokes onClipboardCopy with the decoded text and ok=true after a successful copy", async () => {
    const onCopy = vi.fn();
    const { terminal } = createXtermBackend(options, onCopy);
    terminal.write(osc52(btoa("hi there")));
    await waitForParse();
    // The clipboard write resolves on a microtask; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(onCopy).toHaveBeenCalledWith({ text: "hi there", ok: true });
    terminal.dispose();
  });

  it("does not invoke onClipboardCopy for a read request ('?')", async () => {
    const onCopy = vi.fn();
    const { terminal } = createXtermBackend(options, onCopy);
    terminal.write("\x1b]52;c;?\x07");
    await waitForParse();

    expect(onCopy).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it("round-trips multi-byte UTF-8 (CJK + emoji + accents)", async () => {
    const text = "日本語 🚀 café";
    const { terminal } = createXtermBackend(options);
    terminal.write(osc52(toBase64Utf8(text)));
    await waitForParse();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text);
    terminal.dispose();
  });

  it("drops OSC 52 read requests (payload '?') without touching the clipboard", async () => {
    const { terminal } = createXtermBackend(options);
    terminal.write("\x1b]52;c;?\x07");
    await waitForParse();

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    terminal.dispose();
  });

  it("does not copy (and does not throw) on malformed base64", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { terminal } = createXtermBackend(options);
    terminal.write("\x1b]52;c;@@@not-valid-base64@@@\x07");
    await waitForParse();

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    terminal.dispose();
  });
});

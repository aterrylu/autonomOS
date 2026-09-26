import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  _resetPtyInputLogForTest,
  DEFAULT_WINDOW_MINUTES,
  initPtyInputLog,
  instrumentPtyInput,
  MAX_WINDOW_MINUTES,
  ptyInputLogActive,
  renderPtyInput,
  TRIGGER_FILE,
  withPtyInputSource,
} from "../ptyInputLog.js";

const SRC = join(import.meta.dirname, "..");

describe("renderPtyInput: control and escape bytes verbatim, text redacted", () => {
  it("CR, LF, tab and other controls are spelled out", () => {
    assert.equal(renderPtyInput("\r"), "\\r");
    assert.equal(renderPtyInput("\n\n\n\n"), "\\n\\n\\n\\n");
    assert.equal(renderPtyInput("\t\x15\x03\x7f"), "\\t\\x15\\x03\\x7f");
  });

  it("printable text becomes class + length (code points, not bytes)", () => {
    assert.equal(renderPtyInput("hunter2"), "<printable×7>");
    assert.equal(renderPtyInput("héllo✓"), "<printable×6>");
    assert.equal(renderPtyInput("ab\rcd"), "<printable×2>\\r<printable×2>");
  });

  it("terminal answers and key sequences stay readable", () => {
    assert.equal(renderPtyInput("\x1b[?1;2c"), "\\e[?1;2c"); // DA1 answer
    assert.equal(renderPtyInput("\x1b[I\x1b[O"), "\\e[I\\e[O"); // focus
    assert.equal(renderPtyInput("\x1b[13;2u"), "\\e[13;2u"); // kitty Shift+Enter
    assert.equal(renderPtyInput("\x1bOA"), "\\eOA"); // SS3 arrow
    assert.equal(renderPtyInput("\x1b\r"), "\\e\\r"); // Meta+Enter (newline in CC)
    assert.equal(renderPtyInput("\x1b"), "\\e"); // lone ESC
  });

  it("a bracketed paste keeps its markers and newlines, redacts its text", () => {
    assert.equal(
      renderPtyInput("\x1b[200~line one\nline two\x1b[201~"),
      "\\e[200~<printable×8>\\n<printable×8>\\e[201~",
    );
  });

  it("OSC/DCS bodies are redacted (they can carry text), terminators kept", () => {
    assert.equal(
      renderPtyInput("\x1b]52;c;c2VjcmV0\x07"),
      "\\e]<string×13>\\x07",
    );
    assert.equal(
      renderPtyInput("\x1bP>|xterm.js(6.0.0)\x1b\\"),
      "\\eP<string×17>\\e\\\\",
    );
  });

  it("a malformed CSI can't swallow what follows", () => {
    const out = renderPtyInput(`\x1b[${"1".repeat(40)}`);
    assert.ok(out.startsWith("\\e["));
    assert.match(out, /<printable×\d+>$/, "the tail is redacted, not echoed");
  });

  it("with text=true printable text is verbatim (backslashes escaped)", () => {
    assert.equal(renderPtyInput("a\\b\r", true), "a\\\\b\\r");
    assert.equal(renderPtyInput("\x1b]0;title\x07", true), "\\e]0;title\\x07");
  });
});

describe("withPtyInputSource", () => {
  it("restores the previous source, even when the write throws", () => {
    const seen: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ptylog-src-"));
    try {
      initPtyInputLog({
        configDir: dir,
        env: { AUTONOMOS_PTY_INPUT_LOG: "1" },
      });
      const pty = { write: (_: string) => {} };
      instrumentPtyInput(pty, { sessionId: "abcdef0123", label: "a" });
      withPtyInputSource("auto-trust", () =>
        withPtyInputSource("terminal", () => pty.write("x")),
      );
      assert.throws(() =>
        withPtyInputSource("handoff", () => {
          throw new Error("boom");
        }),
      );
      pty.write("y");
      const log = readFileSync(join(dir, "logs", "pty-input.log"), "utf8");
      for (const line of log.split("\n")) {
        const m = / abcdef01 "a" (\S+) /.exec(line);
        if (m) seen.push(m[1]);
      }
      assert.deepEqual(seen, ["terminal", "unattributed"]);
    } finally {
      _resetPtyInputLogForTest();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pty input log: guardrails", () => {
  let dir: string;
  let warnings: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptylog-"));
    warnings = [];
    mock.method(console, "warn", (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    });
  });
  afterEach(() => {
    mock.restoreAll();
    _resetPtyInputLogForTest();
    rmSync(dir, { recursive: true, force: true });
  });
  const logPath = () => join(dir, "logs", "pty-input.log");

  it("OFF by default: no file, and write() is left exactly as it was", () => {
    assert.equal(initPtyInputLog({ configDir: dir, env: {} }), null);
    const write = (_: string) => {};
    const pty = { write };
    instrumentPtyInput(pty, { sessionId: "s", label: "a" });
    assert.equal(pty.write, write, "not wrapped");
    assert.equal(existsSync(logPath()), false);
    assert.equal(ptyInputLogActive(), false);
    assert.deepEqual(warnings, []);
  });

  it("only the exact value 1 turns it on", () => {
    for (const v of ["true", "yes", "0", ""]) {
      assert.equal(
        initPtyInputLog({
          configDir: dir,
          env: { AUTONOMOS_PTY_INPUT_LOG: v },
        }),
        null,
        v,
      );
    }
  });

  it("ON: 0600 file, loud banner, each write recorded with source and redaction", () => {
    const path = initPtyInputLog({
      configDir: dir,
      env: { AUTONOMOS_PTY_INPUT_LOG: "1" },
    });
    assert.equal(path, logPath());
    assert.equal(statSync(logPath()).mode & 0o777, 0o600);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /\[pty-input-log\] ON: .* redacted to its length/,
    );

    const got: string[] = [];
    const pty = { write: (d: string) => got.push(d) };
    instrumentPtyInput(pty, { sessionId: "0123456789ab", label: "Agent X" });
    withPtyInputSource("terminal", () => pty.write("secret\r"));
    withPtyInputSource("auto-trust", () => pty.write("\r"));
    assert.deepEqual(got, ["secret\r", "\r"], "bytes still reach the PTY");

    const log = readFileSync(logPath(), "utf8");
    assert.match(log, /01234567 "Agent X" terminal len=7 <printable×6>\\r\n/);
    assert.match(log, /01234567 "Agent X" auto-trust len=1 \\r\n/);
    assert.equal(log.includes("secret"), false, "typed text never lands");
  });

  it("TEXT flag: verbatim text, and the banner says secrets will be captured", () => {
    initPtyInputLog({
      configDir: dir,
      env: { AUTONOMOS_PTY_INPUT_LOG: "1", AUTONOMOS_PTY_INPUT_LOG_TEXT: "1" },
    });
    assert.match(warnings[0], /VERBATIM.*passwords or secrets/);
    const pty = { write: (_: string) => {} };
    instrumentPtyInput(pty, { sessionId: "s1234567", label: "a" });
    pty.write("hello\r");
    assert.match(readFileSync(logPath(), "utf8"), / hello\\r\n/);
  });

  it("switches itself off after the window and says so once", () => {
    let t = 1_000_000;
    initPtyInputLog({
      configDir: dir,
      env: {
        AUTONOMOS_PTY_INPUT_LOG: "1",
        AUTONOMOS_PTY_INPUT_LOG_MINUTES: "2",
      },
      now: () => t,
    });
    const pty = { write: (_: string) => {} };
    instrumentPtyInput(pty, { sessionId: "s1234567", label: "a" });
    pty.write("\r");
    t += 2 * 60_000; // exactly at the bound: off
    pty.write("\n");
    pty.write("\n");
    assert.equal(ptyInputLogActive(), false);
    const log = readFileSync(logPath(), "utf8");
    assert.equal(
      (log.match(/len=/g) ?? []).length,
      1,
      "only the in-window write",
    );
    assert.equal((log.match(/window ended/g) ?? []).length, 1);
    assert.equal(
      warnings.filter((w) => w.includes("window ended")).length,
      1,
      "announced once, loudly",
    );
  });

  it("window: default 30 min, clamped to 1..240", () => {
    const until = (raw: string | undefined) => {
      _resetPtyInputLogForTest();
      const env: NodeJS.ProcessEnv = { AUTONOMOS_PTY_INPUT_LOG: "1" };
      if (raw !== undefined) env.AUTONOMOS_PTY_INPUT_LOG_MINUTES = raw;
      initPtyInputLog({ configDir: dir, env, now: () => 0 });
      return Number(/\((\d+) min\)/.exec(warnings.at(-1) ?? "")?.[1]);
    };
    assert.equal(until(undefined), DEFAULT_WINDOW_MINUTES);
    assert.equal(until("abc"), DEFAULT_WINDOW_MINUTES);
    assert.equal(until("-5"), DEFAULT_WINDOW_MINUTES);
    assert.equal(until("0.2"), 1);
    assert.equal(until("100000"), MAX_WINDOW_MINUTES);
    assert.equal(until("45"), 45);
  });

  it("rotated segments stay 0600", () => {
    initPtyInputLog({
      configDir: dir,
      env: { AUTONOMOS_PTY_INPUT_LOG: "1" },
      maxBytes: 300,
    });
    const pty = { write: (_: string) => {} };
    instrumentPtyInput(pty, { sessionId: "s1234567", label: "a" });
    for (let i = 0; i < 20; i++) pty.write("\r\n");
    assert.ok(existsSync(`${logPath()}.1`), "rotated");
    assert.equal(statSync(logPath()).mode & 0o777, 0o600);
    assert.equal(statSync(`${logPath()}.1`).mode & 0o777, 0o600);
  });
});

describe("pty input log: every known writer is attributed", () => {
  // A write site without a tag still gets logged (as "unattributed"), but the
  // forensic value is in the source, so pin the five that exist today.
  const sites: Array<[string, string]> = [
    ["routes/terminal.ts", '"terminal"'],
    ["providers/claude-code.ts", '"auto-trust"'],
    ["agents/runtime.ts", '"prompt-delivery"'],
    ["usageQueue.ts", '"usage-queue"'],
    ["handoffDelivery.ts", '"handoff"'],
  ];
  for (const [file, source] of sites) {
    it(`${file} writes as ${source}`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      assert.ok(
        src.includes(`withPtyInputSource(${source}`) ||
          src.includes(`withPtyInputSource(\n      ${source}`),
        `${file} tags its PTY write with ${source}`,
      );
    });
  }

  it("runtime instruments every spawned PTY", () => {
    const src = readFileSync(join(SRC, "agents/runtime.ts"), "utf8");
    assert.match(src, /instrumentPtyInput\(pty,/);
  });
});

describe("pty input log: one-shot trigger file", () => {
  let dir: string;
  let warnings: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ptylog-trig-"));
    warnings = [];
    mock.method(console, "warn", (...a: unknown[]) => {
      warnings.push(a.map(String).join(" "));
    });
  });
  afterEach(() => {
    mock.restoreAll();
    _resetPtyInputLogForTest();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("turns logging on for ONE start and is consumed", () => {
    writeFileSync(join(dir, TRIGGER_FILE), "");
    assert.ok(initPtyInputLog({ configDir: dir, env: {} }), "on");
    assert.equal(existsSync(join(dir, TRIGGER_FILE)), false, "consumed");
    assert.match(warnings[0], /this start only/);
    _resetPtyInputLogForTest();
    assert.equal(
      initPtyInputLog({ configDir: dir, env: {} }),
      null,
      "next start: off",
    );
  });

  it("fails CLOSED when the trigger can't be removed", () => {
    writeFileSync(join(dir, TRIGGER_FILE), "");
    // logs/ stays writable, so ONLY the removal fails: a fail-open build
    // would happily log here, and keep re-arming at every start.
    mkdirSync(join(dir, "logs"), { mode: 0o700 });
    chmodSync(dir, 0o500);
    assert.equal(initPtyInputLog({ configDir: dir, env: {} }), null);
    assert.equal(ptyInputLogActive(), false);
    assert.match(warnings[0], /stays OFF/);
  });
});

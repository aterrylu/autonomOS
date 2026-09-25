import { describe, expect, it } from "vitest";
import { describePaneConnection } from "../components/PaneConnectionChip";
import {
  classifyIoProbe,
  decodeAckFrame,
  encodeInputFrame,
  isCountableInput,
  isMouseReport,
  isTerminalReply,
  isUserInput,
} from "./connectionWatch";

describe("isCountableInput — which keys must visibly produce output", () => {
  it("counts printable text, a paste, Enter, Backspace, Tab", () => {
    for (const k of ["a", "Z", " ", "hello world", "\r", "\x7f", "\t", "é"]) {
      expect(isCountableInput(k), JSON.stringify(k)).toBe(true);
    }
  });
  it("ignores escape sequences (arrows, focus reports) and bare control bytes", () => {
    // An arrow at a boundary legitimately changes nothing on screen; it must
    // neither arm the watchdog nor count as a dropped keystroke.
    for (const k of [
      "\x1b[A",
      "\x1b[B",
      "\x1b[I",
      "\x1b",
      "\x03",
      "\x00",
      "",
    ]) {
      expect(isCountableInput(k), JSON.stringify(k)).toBe(false);
    }
  });
});

describe("classifyIoProbe — whose silence is it?", () => {
  it("server never saw our key → the pane socket is dead", () => {
    expect(classifyIoProbe({ inputAgeMs: null, outputAgeMs: 100 }, 6000)).toBe(
      "socket-dead",
    );
    // Last input the server saw is OLDER than our keystroke.
    expect(
      classifyIoProbe({ inputAgeMs: 60_000, outputAgeMs: 60_000 }, 6000),
    ).toBe("socket-dead");
  });

  it("server produced output AFTER our key that we never received → downstream dead", () => {
    expect(classifyIoProbe({ inputAgeMs: 5800, outputAgeMs: 200 }, 6000)).toBe(
      "socket-dead",
    );
  });

  it("server got our key and the agent printed nothing since → agent silent", () => {
    expect(
      classifyIoProbe({ inputAgeMs: 5900, outputAgeMs: 40_000 }, 6000),
    ).toBe("agent-silent");
    expect(classifyIoProbe({ inputAgeMs: 5900, outputAgeMs: null }, 6000)).toBe(
      "agent-silent",
    );
  });

  it("tolerates request latency / clock jitter within the slack", () => {
    // The server saw the key 6.5s ago while we think we sent it 6s ago.
    expect(classifyIoProbe({ inputAgeMs: 6500, outputAgeMs: 9000 }, 6000)).toBe(
      "agent-silent",
    );
  });
});

describe("describePaneConnection — truthful wording per cause", () => {
  it("dead socket says connection lost, with the dropped-key count", () => {
    expect(
      describePaneConnection({ kind: "lost", droppedKeys: 0 }, 0)?.text,
    ).toBe("Connection lost · reconnecting…");
    expect(
      describePaneConnection({ kind: "lost", droppedKeys: 3 }, 0)?.text,
    ).toBe("Connection lost · reconnecting… · 3 keystrokes not sent");
    expect(
      describePaneConnection({ kind: "lost", droppedKeys: 1 }, 0)?.text,
    ).toContain("1 keystroke not sent");
  });

  it("a silent agent is NOT a disconnect, and counts up", () => {
    const d = describePaneConnection({ kind: "silent", since: 1000 }, 9000);
    expect(d?.text).toBe("Agent not responding · 8s");
    expect(d?.text).not.toMatch(/connect/i);
  });

  it("healthy with nothing dropped renders nothing; dropped keys leave a notice", () => {
    expect(
      describePaneConnection({ kind: "ok", droppedKeys: 0 }, 0),
    ).toBeNull();
    expect(
      describePaneConnection({ kind: "ok", droppedKeys: 2 }, 0)?.text,
    ).toBe(
      "Reconnected · 2 keystrokes typed while disconnected may not have been sent",
    );
  });
});

describe("isTerminalReply — xterm's automatic answers, never keystrokes", () => {
  it("matches the replies a replayed scrollback provokes", () => {
    for (const r of [
      "\x1b[?1;2c", // DA1 — the "1;2c" measured in gemini's prompt
      "\x1b[>0;276;0c", // DA2
      "\x1b[12;40R", // CPR
      "\x1b[0n", // DSR ok
      "\x1b[?2026;2$y", // DECRPM (synchronized output)
      "\x1b[?0u", // kitty keyboard flags
      "\x1b]11;rgb:0a0a/0e0e/1414\x07", // OSC 11 background, BEL
      "\x1b]10;rgb:b3b3/b1b1/adad\x1b\\", // OSC 10 foreground, ST
      "\x1bP>|xterm.js(6.0.0)\x1b\\", // XTVERSION
    ]) {
      expect(isTerminalReply(r), JSON.stringify(r)).toBe(true);
    }
  });
  it("never matches real keys, pastes, or focus reports", () => {
    for (const k of [
      "a",
      "1;2c", // the same text TYPED by a person
      "\r",
      "\x1b[A", // arrow
      "\x1b[1;5C", // ctrl+right
      "\x1b[15~", // F5
      "\x1bb", // alt+b
      "\x1b[I", // focus in — from a focus event, not replay
      "\x1b[200~pasted\x1b[201~",
    ]) {
      expect(isTerminalReply(k), JSON.stringify(k)).toBe(false);
    }
  });
});

describe("isUserInput — what counts as a keystroke the user needs to hear about", () => {
  it("keys, Esc and Ctrl+C count; replies, focus reports and mouse reports don't", () => {
    for (const k of ["a", "\r", "\x1b", "\x03", "\x1b[A", "\x15"]) {
      expect(isUserInput(k), JSON.stringify(k)).toBe(true);
    }
    for (const k of [
      "\x1b[?1;2c",
      "\x1b[I",
      "\x1b[O",
      "\x1b[<0;50;20M", // SGR press — measured: a click sent these
      "\x1b[<0;50;20m", // SGR release
      "\x1b[<64;10;5M", // wheel
      "\x1b[M !!", // legacy X10
    ]) {
      expect(isUserInput(k), JSON.stringify(k)).toBe(false);
    }
    expect(isMouseReport("\x1b[<0;50;20M")).toBe(true);
    expect(isMouseReport("\x1b[A")).toBe(false);
  });
});

describe("revision 2 wording + frame codec", () => {
  it("unacked names the problem and the count; waiting is subtle; exact drops say weren't", () => {
    expect(describePaneConnection({ kind: "unacked", keys: 2 }, 0)?.text).toBe(
      "Not reaching server… · 2 keystrokes waiting",
    );
    const w = describePaneConnection({ kind: "waiting", since: 0 }, 2_500);
    expect(w?.text).toBe("Waiting for agent…");
    expect(w?.subtle).toBe(true);
    expect(
      describePaneConnection({ kind: "ok", droppedKeys: 2, exact: true }, 0)
        ?.text,
    ).toBe("Reconnected · 2 keystrokes typed while disconnected weren't sent");
    expect(
      describePaneConnection({ kind: "ok", droppedKeys: 1, exact: true }, 0)
        ?.text,
    ).toBe("Reconnected · 1 keystroke typed while disconnected wasn't sent");
    expect(
      describePaneConnection({ kind: "ok", droppedKeys: 2, exact: false }, 0)
        ?.text,
    ).toContain("may not have been sent");
  });

  it("input frames round-trip through the server's layout; ack frames decode, anything else is null", () => {
    const f = encodeInputFrame(7, 1234.6, "héllo");
    expect(f[0]).toBe(0x01);
    const v = new DataView(f.buffer);
    expect(v.getUint32(1)).toBe(7);
    expect(v.getUint32(5)).toBe(1235);
    expect(new TextDecoder().decode(f.subarray(9))).toBe("héllo");
    const a = new ArrayBuffer(5);
    new DataView(a).setUint8(0, 0x02);
    new DataView(a).setUint32(1, 42);
    expect(decodeAckFrame(a)).toBe(42);
    expect(decodeAckFrame(new ArrayBuffer(4))).toBeNull();
    const wrongType = new ArrayBuffer(5);
    new DataView(wrongType).setUint8(0, 0x01);
    expect(decodeAckFrame(wrongType)).toBeNull();
  });
});

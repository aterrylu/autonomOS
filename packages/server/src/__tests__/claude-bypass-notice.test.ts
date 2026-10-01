import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { ResolvedSpawnOptions } from "@autonomos/core";
import {
  _getPhaseForTesting,
  notePromptHookEvent,
  noteStartupNotice,
  noteStartupSettled,
  _resetForTesting as resetPromptDelivery,
  trackPromptDelivery,
} from "../agents/promptDelivery.js";
import { createStartupNoticeScanner } from "../agents/startupNotices.js";
import {
  attachStartupWatcherCore,
  claudeCodeProvider,
} from "../providers/claude-code.js";
import { ANSI_RE, despace } from "../providers/ptyText.js";

/**
 * Claude Code's Bypass Permissions consent screen. A bypass agent on a machine
 * that never accepted it waits on this screen forever (its default is
 * "No, exit"), and the operator used to hear only "may have failed to boot".
 * Guards: the notice fires on the REAL render, and nothing ever types into it.
 */

/** Verbatim PTY output of `claude --dangerously-skip-permissions` (2.1.286)
 *  up to the consent screen, captured from a real render. */
const BYPASS_DIALOG_2_1_286 =
  "\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\u001b[<u\u001b[>5u\u001b[>4;2m\n\n\u001b[38;5;211m\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u001b[39m\n\n\u001b[3G\u001b[38;5;211m\u001b[1mWARNING:\u001b[12GClaude\u001b[19GCode\u001b[24Grunning\u001b[32Gin\u001b[35GBypass\u001b[42GPermissions\u001b[54Gmode\u001b[22m\u001b[39m\n\n\n\n\u001b[3GIn\u001b[6GBypass\u001b[13GPermissions\u001b[25Gmode,\u001b[31GClaude\u001b[38GCode\u001b[43Gwill\u001b[48Gnot\u001b[52Gask\u001b[56Gfor\u001b[60Gyour\u001b[65Gapproval\u001b[74Gbefore\u001b[81Grunning\u001b[89Gpotentially\u001b[101Gdangerous\n\n\u001b[3Gcommands.\n\n\u001b[3GThis\u001b[8Gmode\u001b[13Gshould\u001b[20Gonly\u001b[25Gbe\u001b[28Gused\u001b[33Gin\u001b[36Ga\u001b[38Gsandboxed\u001b[48Gcontainer/VM\u001b[61Gthat\u001b[66Ghas\u001b[70Grestricted\u001b[81Ginternet\u001b[90Gaccess\u001b[97Gand\u001b[101Gcan\u001b[105Geasily\u001b[112Gbe\n\n\u001b[3Grestored\u001b[12Gif\u001b[15Gdamaged.\n\n\n\n\u001b[3GBy\u001b[6Gproceeding,\u001b[18Gyou\u001b[22Gaccept\u001b[29Gall\u001b[33Gresponsibility\u001b[48Gfor\u001b[52Gactions\u001b[60Gtaken\u001b[66Gwhile\u001b[72Grunning\u001b[80Gin\u001b[83GBypass\u001b[90GPermissions\u001b[102Gmode.\n\n\n\n\u001b[3G\u001b]8;id=zaxmda;https://code.claude.com/docs/en/security\u0007https://code.claude.com/docs/en/security\u001b]8;;\u0007\n\n\n\n\u001b[3G\u001b[38;5;153m\u276f\u001b[5GNo,\u001b[9Gexit\u001b[39m\n\n\u001b[5GYes,\u001b[10GI\u001b[12Gaccept\n\n\n\n\u001b[3G\u001b[38;5;246m\u001b[3mEnter\u001b[9Gto\u001b[12Gconfirm\u001b[20G\u00b7\u001b[22GEsc\u001b[26Gto\u001b[29Gcancel\u001b[23m\u001b[39m\n\n\u001b[2C\u001b[4A\u001b[>0q\u001b[?u\u001b[c\u001b[?2026$p\u001b[c";

const notices = claudeCodeProvider.startupNotices ?? [];

function scan(chunks: string[]): string[] {
  const seen: string[] = [];
  const feed = createStartupNoticeScanner(notices, (m) => seen.push(m));
  for (const c of chunks) feed(c);
  return seen;
}

function chunked(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

describe("Claude Code bypass consent: startup notice", () => {
  it("the fixture really is the consent screen (precondition)", () => {
    // CC spaces words with cursor moves, not spaces: compare as the scanner does.
    const text = despace(BYPASS_DIALOG_2_1_286.replace(ANSI_RE, ""));
    assert.ok(
      text.includes(despace("Claude Code running in Bypass Permissions mode")),
    );
    assert.ok(text.includes("No,exit"));
    assert.ok(
      /\x1b\[\d*C/.test(BYPASS_DIALOG_2_1_286),
      "real render bytes, cursor moves and all",
    );
  });

  it("fires once on the real render, whole or split into tiny chunks", () => {
    assert.equal(scan([BYPASS_DIALOG_2_1_286]).length, 1);
    for (const n of [1, 7, 64]) {
      assert.equal(
        scan(chunked(BYPASS_DIALOG_2_1_286, n)).length,
        1,
        `chunks of ${n}`,
      );
    }
  });

  it("the notice names the screen and promises nothing gets typed", () => {
    const [msg] = scan([BYPASS_DIALOG_2_1_286]);
    assert.match(msg, /Bypass Permissions mode/);
    assert.match(msg, /never accepts it for you/);
  });

  it("stays quiet on an ordinary start (channels warning, prompt)", () => {
    const ordinary =
      "WARNING: Loading development channels\nI am using this for local development\n" +
      "⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ";
    assert.deepEqual(scan([ordinary]), []);
  });
});

class FakePty {
  writeCalls = 0;
  private handlers: Array<(d: string) => void> = [];
  write(_: string): void {
    this.writeCalls++;
  }
  onData(cb: (d: string) => void) {
    this.handlers.push(cb);
    const hs = this.handlers;
    return { dispose: () => hs.splice(hs.indexOf(cb), 1) };
  }
  get watcherCount() {
    return this.handlers.length;
  }
  emit(d: string) {
    for (const h of [...this.handlers]) h(d);
  }
}

const OPTS = {
  agentName: "bypass-test",
  sessionId: "0123abcd-aaaa-bbbb-cccc-0123456789ab",
} as ResolvedSpawnOptions;

describe("Claude Code bypass consent: autonomOS types NOTHING into it", () => {
  afterEach(() => mock.timers.reset());

  for (const expectChannels of [true, false]) {
    for (const trustOptional of [true, false]) {
      it(`zero bytes written (channels ${expectChannels ? "on" : "off"}, trust ${trustOptional ? "pre-trusted" : "required"})`, () => {
        mock.timers.enable({
          apis: ["setTimeout", "setInterval", "Date"],
          now: 0,
        });
        mock.method(console, "warn", () => {});
        mock.method(console, "log", () => {});
        const pty = new FakePty();
        attachStartupWatcherCore(pty, OPTS, {
          expectChannels,
          trustOptional,
          retryDelayMs: 20,
          maxAttempts: 5,
          interKeyDelayMs: 5,
          timeoutMs: 500,
        });
        for (const c of chunked(BYPASS_DIALOG_2_1_286, 64)) pty.emit(c);
        // Re-renders while it waits change nothing either.
        mock.timers.tick(100);
        pty.emit(BYPASS_DIALOG_2_1_286);
        mock.timers.tick(1000); // well past the watcher's hard timeout
        assert.equal(pty.watcherCount, 0, "the watcher finished");
        assert.equal(pty.writeCalls, 0, "not a single keystroke");
        mock.restoreAll();
      });
    }
  }
});

describe("Claude Code bypass consent: prompt delivery reports it, not a failed boot", () => {
  const sid = "bypass-pd-session";
  afterEach(() => {
    resetPromptDelivery();
    mock.restoreAll();
  });

  function fakeIO() {
    const notifications: string[] = [];
    const writes: string[] = [];
    const io: Parameters<typeof trackPromptDelivery>[3] = {
      write: (d) => {
        writes.push(d);
        return true;
      },
      notify: (m) => {
        notifications.push(m);
        return `n-${notifications.length}`;
      },
      retract: () => true,
      sessionStartTimeoutMs: 20,
      promptSubmitTimeoutMs: 10_000,
      redeliverEnterDelayMs: 5,
      settleFallbackMs: 10_000,
      givenUpRetentionMs: 10_000,
    };
    return { io, notifications, writes };
  }

  it("after the notice: no generic warning, parked, and a late SessionStart resumes", async () => {
    const warns: string[] = [];
    mock.method(console, "warn", (...a: unknown[]) => warns.push(a.join(" ")));
    const f = fakeIO();
    trackPromptDelivery(sid, "bp", "do it", f.io);
    noteStartupNotice(
      sid,
      "Claude Code is asking you to accept Bypass Permissions mode",
    );
    noteStartupSettled(sid);
    for (let i = 0; i < 100 && _getPhaseForTesting(sid) !== "given_up"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(_getPhaseForTesting(sid), "given_up");
    assert.deepEqual(
      f.notifications,
      [],
      "the startup notice already said it; no second warning",
    );
    assert.ok(
      warns.some((w) =>
        /waiting on a startup screen the operator was told about/.test(w),
      ),
    );
    assert.ok(
      !warns.some((w) => /failed to boot/.test(w)),
      "no misleading boot-failure line",
    );
    // The human accepts: CC boots and the tracker picks up again.
    notePromptHookEvent(sid, "SessionStart", "startup");
    assert.equal(_getPhaseForTesting(sid), "awaiting_prompt_submit");
    assert.deepEqual(f.writes, [], "nothing typed while it waited");
  });

  it("without a notice the generic warning still fires (unchanged)", async () => {
    mock.method(console, "warn", () => {});
    const f = fakeIO();
    trackPromptDelivery(sid, "bp", "do it", f.io);
    noteStartupSettled(sid);
    for (let i = 0; i < 100 && f.notifications.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0], /never reported SessionStart/);
  });
});

describe("Claude Code bypass consent: runtime wiring", () => {
  it("a fired startup notice is passed on to prompt delivery", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../agents/runtime.ts", import.meta.url),
      "utf8",
    );
    const cb = src.slice(
      src.indexOf("createStartupNoticeScanner(provider.startupNotices"),
    );
    const body = cb.slice(0, cb.indexOf("});"));
    assert.match(body, /noteStartupNotice\(resolved\.sessionId, msg\)/);
  });
});

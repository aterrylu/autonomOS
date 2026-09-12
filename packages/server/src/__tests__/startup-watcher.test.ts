import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PtyHandle, ResolvedSpawnOptions } from "@autonomos/core";
import {
  attachStartupWatcherCore,
  type StartupWatcherConfig,
} from "../providers/claude-code.js";

/**
 * Unit coverage for the needle-driven auto-trust watcher. A scripted fake
 * terminal lets us simulate the exact race the watcher exists to win: CC's
 * TUI rendering the trust dialog before its stdin handler is attached, so
 * early Enters are silently dropped.
 *
 * Timing discipline (why this file was deflaked): the watcher's Enters and its
 * disposal land from *timer* callbacks (retry loop, scripted dialog dismissal).
 * Asserting after a fixed `await sleep(N)` raced those callbacks under
 * full-suite load, so we POLL for the terminal effect ({@link waitFor}) —
 * usually `watcherCount === 0` (disposal is monotonic and always eventually
 * reached: dismissal, give-up, timeout, or dead-pty) — then assert on the
 * writes. Waits that assert an effect must NOT happen still sleep a bounded
 * window; those can't false-fail from load.
 */

const TRUST_DIALOG =
  "Do you trust the files in this folder?\n❯ Yes, I trust this folder\nNo, exit";
/** The ≥2.1.26x "Quick safety check" variant — DEFAULT selection is No. */
const TRUST_DIALOG_DEFAULT_NO =
  "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel";
/** Selection re-render after a landed Down on the default-No dialog. */
const TRUST_DIALOG_YES_SELECTED = " No, exit\n❯ Yes, I trust this folder";
const DOWN = "\x1b[B";
const CHANNELS_DIALOG =
  "WARNING: Loading development channels\nI am using this for local development";
/** A realistic post-dialog screen transition: a real dismissal repaints the
 *  whole viewport, far above the watcher's dismissal-evidence floor. */
const WELCOME =
  '\x1b[2J\x1b[H> Try "write a test for <filepath>" · ? for shortcuts';

class FakePty implements PtyHandle {
  written: string[] = [];
  private handlers: Array<(data: string) => void> = [];
  /** When false, writes are swallowed (stdin handler not attached yet). */
  stdinAttached = true;
  /** Called for every write that lands (stdin attached). */
  onWrite: ((data: string) => void) | null = null;
  throwOnWrite = false;

  write(data: string): void {
    if (this.throwOnWrite) throw new Error("EIO: pty closed");
    if (!this.stdinAttached) return; // swallowed — the race
    this.written.push(data);
    this.onWrite?.(data);
  }

  onData(callback: (data: string) => void): { dispose(): void } {
    this.handlers.push(callback);
    const handlers = this.handlers;
    return {
      dispose() {
        const i = handlers.indexOf(callback);
        if (i >= 0) handlers.splice(i, 1);
      },
    };
  }

  get watcherCount(): number {
    return this.handlers.length;
  }

  emit(data: string): void {
    for (const h of [...this.handlers]) h(data);
  }
}

const OPTS = {
  agentName: "watcher-test",
  sessionId: "01234567-aaaa-bbbb-cccc-0123456789ab",
} as ResolvedSpawnOptions;

const FAST: Omit<StartupWatcherConfig, "expectChannels"> = {
  retryDelayMs: 20,
  maxAttempts: 5,
  interKeyDelayMs: 5,
  timeoutMs: 500,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll `predicate` until true, or throw after `timeoutMs`. Replaces
 * `sleep(guess)` for any assertion that an effect HAS happened: returns the
 * instant it's observed (fast + load-independent) instead of betting on a fixed
 * delay. 1s cap is far above any real callback latency.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms waiting for: ${what}`,
      );
    }
    await sleep(2);
  }
}

describe("startup watcher — needle-driven retry", () => {
  it("happy path: Enter lands, dialog clears → exactly one Enter, watcher disposes", async () => {
    const pty = new FakePty();
    // Dialog dismissal: when the Enter lands, the TUI redraws without the needle.
    pty.onWrite = () => setTimeout(() => pty.emit(WELCOME), 5);
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 0, "dismissed → watcher disposed");

    assert.deepEqual(pty.written, ["\r"], "exactly one Enter");
  });

  it("THE RACE: early Enters swallowed pre-attach → retries until stdin attaches", async () => {
    const pty = new FakePty();
    // High attempt budget: the detached window below can stretch under load, and
    // the retry loop must NOT exhaust (give up) before stdin attaches — that
    // exhaustion was the flake. With a generous budget the only terminations are
    // "stdin attaches → Enter lands → dismissal" (what we assert).
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      maxAttempts: 50,
    });

    // stdin not attached YET: Enters sent now are dropped, dialog stays silent.
    pty.stdinAttached = false;
    pty.emit(TRUST_DIALOG);
    await sleep(30); // some retries fire and get swallowed while detached
    assert.deepEqual(
      pty.written,
      [],
      "Enters are swallowed while stdin is detached",
    );

    pty.stdinAttached = true;
    pty.onWrite = () => setTimeout(() => pty.emit(WELCOME), 5);
    await waitFor(
      () => pty.watcherCount === 0,
      "a retried Enter lands once stdin attaches → dismissal disposes",
    );

    assert.deepEqual(
      pty.written,
      ["\r"],
      "a retried Enter eventually lands once stdin attaches",
    );
  });

  it("dialog re-renders the needle after a dropped Enter → retry fires", async () => {
    const pty = new FakePty();
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.written.length >= 1, "first Enter");
    // Simulate the TUI repainting the same dialog (needle in FRESH output).
    pty.emit(TRUST_DIALOG);
    await waitFor(
      () => pty.written.length >= 2,
      "needle re-render triggers a retry Enter",
    );
    pty.onWrite = null;
    assert.ok(pty.written.length >= 2, "needle re-render must trigger a retry");

    // Now let it dismiss.
    pty.emit(WELCOME);
    await waitFor(() => pty.watcherCount === 0, "dismissed after welcome");
  });

  it("caps at maxAttempts then gives up without spinning forever", async () => {
    const pty = new FakePty();
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      maxAttempts: 3,
    });

    // Perpetually silent terminal — every Enter lands but nothing reacts, so the
    // watcher exhausts its attempts and disposes.
    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 0, "gave up after maxAttempts");

    assert.equal(pty.written.length, 3, "exactly maxAttempts Enters");
  });

  it("channels dialog: handled after trust, and its appearance marks trust dismissed", async () => {
    const pty = new FakePty();
    pty.onWrite = () => setTimeout(() => pty.emit(WELCOME), 5);
    attachStartupWatcherCore(pty, OPTS, { expectChannels: true, ...FAST });

    // Channels dialog appears without the trust needle ever showing (folder
    // already trusted) — watcher must not hang waiting for trust.
    pty.emit(CHANNELS_DIALOG);
    await waitFor(
      () => pty.watcherCount === 0,
      "channels dismissed → trust implied → all done",
    );

    assert.deepEqual(pty.written, ["\r"], "one Enter for the channels dialog");
  });

  it("both dialogs in sequence are each dismissed", async () => {
    const pty = new FakePty();
    attachStartupWatcherCore(pty, OPTS, { expectChannels: true, ...FAST });

    // Scripted terminal: the first landed Enter dismisses trust and reveals
    // the channels dialog; the second dismisses channels.
    let stage = 0;
    pty.onWrite = () => {
      stage++;
      if (stage === 1)
        setTimeout(
          () =>
            pty.emit(
              `\x1b[2J\x1b[H${CHANNELS_DIALOG} — review before continuing`,
            ),
          5,
        );
      else setTimeout(() => pty.emit(WELCOME), 5);
    };
    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 0, "both dialogs dismissed");

    assert.equal(pty.written.length, 2, "one Enter per dialog");
  });

  it("needle detection survives ANSI styling and \\r line discipline", async () => {
    const pty = new FakePty();
    pty.onWrite = () => setTimeout(() => pty.emit(WELCOME), 5);
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    // The \r is stripped by the watcher's ANSI/control filter, rejoining the
    // needle text exactly as real CC TUI output does. The styled ❯Yes
    // highlight is what authorizes the Enter — see the unrecognized-layout
    // test for the no-highlight contract.
    pty.emit("\x1b[1m\x1b[32m❯ Yes, I trust\r this folder\x1b[0m");
    await waitFor(
      () => pty.watcherCount === 0,
      "ANSI-wrapped needle dismissed",
    );
    assert.deepEqual(pty.written, ["\r"], "ANSI-wrapped needle still detected");
  });

  it("UNRECOGNIZED LAYOUT: a trust dialog with no ❯ highlight is never answered", async () => {
    // If CC redesigns the dialog (new glyph, reverse-video selection), the
    // only blind answer available is a bare Enter — the key that EXITS a
    // default-No dialog. Stuck-but-alive is operator-recoverable; exited is
    // not. The watcher must refuse to answer and settle loudly.
    const pty = new FakePty();
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(
      "Do you trust the files in this folder?\nYes, I trust this folder\nNo, exit",
    );
    await waitFor(() => pty.watcherCount === 0, "settled without answering");
    assert.deepEqual(pty.written, [], "no keystroke on an unrecognized layout");
  });

  it("PTY write throwing marks the pty dead and disposes cleanly", async () => {
    const pty = new FakePty();
    pty.throwOnWrite = true;
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG);
    await waitFor(
      () => pty.watcherCount === 0,
      "disposed after dead-pty detection",
    );
    assert.deepEqual(pty.written, []);
  });

  it("hard timeout disposes the watcher even when no dialog ever appears", async () => {
    const pty = new FakePty();
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      timeoutMs: 60,
    });
    pty.emit("plain startup output, folder already trusted");
    await waitFor(() => pty.watcherCount === 0, "timed out and disposed");
    assert.deepEqual(pty.written, []);
  });
});

/**
 * The ≥2.1.26x trust dialog (default "❯ No, exit") and the false-settle
 * verification gap — both halves of the incident where auto-trust either
 * killed a spawned session (bare Enter landing on "No, exit") or reported a
 * still-visible dialog as dismissed (any needle-free byte counted as
 * evidence). Each test here was written RED against the pre-fix watcher.
 */
describe("startup watcher — default-No trust dialog + verified dismissal", () => {
  it("default-No dialog: answers Down+Enter, never a bare Enter", async () => {
    const pty = new FakePty();
    let sawDown = false;
    pty.onWrite = (data) => {
      if (data === DOWN) {
        sawDown = true;
        setTimeout(() => pty.emit(TRUST_DIALOG_YES_SELECTED), 2);
        return;
      }
      // A bare Enter before Down would confirm "No, exit" and kill the
      // session — the exact pre-fix behavior this test exists to forbid.
      assert.ok(
        sawDown,
        `bare "${JSON.stringify(data)}" while ❯ sits on "No, exit" would exit claude`,
      );
      setTimeout(() => pty.emit(WELCOME), 2);
    };
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG_DEFAULT_NO);
    await waitFor(() => pty.watcherCount === 0, "dismissed via Down+Enter");
    assert.deepEqual(pty.written, [DOWN, "\r"], "Down then Enter, in order");
  });

  it("Down lands but Enter is swallowed → retry re-reads ❯ on Yes → bare Enter", async () => {
    const pty = new FakePty();
    let entersLand = false;
    pty.onWrite = (data) => {
      if (data === DOWN) {
        // Selection moves; the re-render CONTAINS the needle, so the check
        // window sees the dialog still up and retries.
        setTimeout(() => pty.emit(TRUST_DIALOG_YES_SELECTED), 2);
      } else if (data === "\r" && entersLand) {
        setTimeout(() => pty.emit(WELCOME), 2);
      }
      // a swallowed Enter: landed on the fake but the TUI ignores it
    };
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG_DEFAULT_NO);
    // Let the FIRST attempt's Enter go through ignored (the swallow), then
    // allow later Enters to land.
    await waitFor(
      () => pty.written.filter((k) => k === "\r").length >= 1,
      "first attempt's Enter sent (and ignored)",
    );
    entersLand = true;
    await waitFor(() => pty.watcherCount === 0, "later Enter dismisses");
    // The retry after the ❯-on-Yes re-render must NOT resend Down (that
    // would move the highlight back off Yes) — highlight is re-read.
    const afterFirstPair = pty.written.slice(2);
    assert.ok(
      afterFirstPair.length > 0 && afterFirstPair.every((k) => k === "\r"),
      `retries after ❯ moved to Yes are bare Enters, saw ${JSON.stringify(pty.written)}`,
    );
  });

  it("FALSE-SETTLE (the bug): sub-floor repaint residue is not a dismissal", async () => {
    const pty = new FakePty();
    // Swallow everything — the stdin-attach race in its stuck form.
    pty.stdinAttached = false;
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      maxAttempts: 50,
    });

    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 1, "engaged");
    // The exact residue observed in the live failure: stripped-CSI fragments
    // a few chars long, arriving while the dialog still fills the screen.
    // Pre-fix, this settled the watcher after ONE swallowed Enter.
    pty.emit("78");
    await sleep(120); // several check windows
    assert.equal(
      pty.watcherCount,
      1,
      "residue must NOT settle the watcher while the dialog is still up",
    );

    // Stdin attaches; a retried Enter lands and genuinely dismisses.
    pty.stdinAttached = true;
    pty.onWrite = () => setTimeout(() => pty.emit(WELCOME), 2);
    await waitFor(() => pty.watcherCount === 0, "real dismissal settles");
    assert.ok(pty.written.length >= 1, "a retried Enter landed");
  });

  it("mode-report chatter like ESC[>0q strips to nothing (counts as silence)", async () => {
    const pty = new FakePty();
    pty.stdinAttached = false;
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      maxAttempts: 3,
    });
    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 1, "engaged");
    // Pre-fix ANSI_RE left "0q"/"4m" fragments from these, which then passed
    // the (old) any-byte dismissal check and settled the watcher instantly.
    pty.emit("\x1b[>0q\x1b[>4m\x1b[<u");
    await sleep(60); // multiple check windows at FAST timing
    assert.equal(
      pty.watcherCount,
      1,
      "stripped-to-nothing chatter must not settle the watcher",
    );
    await waitFor(() => pty.watcherCount === 0, "exhausts attempts");
    assert.deepEqual(
      pty.written,
      [],
      "all swallowed — and never settled early",
    );
  });

  it("confirmation window: a needle re-render after a plausible transition retries", async () => {
    const pty = new FakePty();
    let attempts = 0;
    pty.onWrite = (data) => {
      if (data !== "\r") return;
      attempts++;
      if (attempts === 1) {
        // A transition-sized banner… followed by the dialog re-rendering
        // inside the confirmation window. Pre-fix: settled at first check.
        setTimeout(() => pty.emit(WELCOME), 2);
        setTimeout(() => pty.emit(TRUST_DIALOG), 30);
      } else {
        setTimeout(() => pty.emit(WELCOME), 2);
      }
    };
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 0, "second attempt dismisses");
    assert.ok(
      attempts >= 2,
      `the re-rendered needle inside the confirmation window must trigger a retry (attempts=${attempts})`,
    );
  });

  it("REAL RENDER BYTES: highlight detection survives CC's actual CSI-interleaved frames", async () => {
    // Fixtures below are VERBATIM raw captures from claude 2.1.269 (cursor
    // positioning interleaved with glyphs). The first shipped version of the
    // highlight needles assumed clean spacing, matched nothing on these, and
    // degraded to the fatal bare Enter — while spacing-matched fakes kept
    // the suite green. Real bytes are the only honest fixture.
    const RAW_DEFAULT_NO =
      "Yes, I trust this folder\n\x1b[1C\x1b[4A\x1b[38;5;153m\u276f\x1b[4GNo, exit\n\x1b[1C\x1b[1B\x1b[39m \x1b[4GYes, I trust this folder";
    const RAW_YES_SELECTED =
      "\x1b[4GNo, exit\n\x1b[1C\x1b[1B\x1b[38;5;153m\u276f\x1b[4GYes, I trust this folder\x1b[39m";
    const pty = new FakePty();
    let sawDown = false;
    pty.onWrite = (data) => {
      if (data === DOWN) {
        sawDown = true;
        setTimeout(() => pty.emit(RAW_YES_SELECTED), 2);
        return;
      }
      assert.ok(sawDown, "bare Enter on the raw default-No frame is the kill");
      setTimeout(() => pty.emit(WELCOME), 2);
    };
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(RAW_DEFAULT_NO);
    await waitFor(() => pty.watcherCount === 0, "raw frames dismissed");
    assert.deepEqual(pty.written, [DOWN, "\r"]);
  });

  it("REMOUNT RACE: selection resetting to No after Down blocks the Enter", async () => {
    const pty = new FakePty();
    let attempt2Enters = 0;
    let down = 0;
    pty.onWrite = (data) => {
      if (data === DOWN) {
        down++;
        if (down === 1) {
          // Down lands, ❯ moves to Yes — then an Ink re-mount (resize
          // nudge) repaints the dialog with its DEFAULT selection before
          // the watcher's confirm poll. This is the observed
          // 0.7s-post-spawn kill: a blind Enter here confirms "No, exit".
          // (A remount INSIDE the final poll gap is unwinnable from outside
          // the process — that residue is what spawn-side pre-trust removes.)
          pty.emit(TRUST_DIALOG_YES_SELECTED);
          pty.emit(TRUST_DIALOG_DEFAULT_NO);
        } else {
          // The retry's Down lands on a stable dialog.
          setTimeout(() => pty.emit(TRUST_DIALOG_YES_SELECTED), 2);
        }
        return;
      }
      // Any Enter written while the LATEST highlight was "No, exit" would
      // have exited claude.
      assert.ok(
        down >= 2,
        "Enter must not be written after the selection reset to No",
      );
      attempt2Enters++;
      setTimeout(() => pty.emit(WELCOME), 2);
    };
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    pty.emit(TRUST_DIALOG_DEFAULT_NO);
    await waitFor(() => pty.watcherCount === 0, "retry navigates and confirms");
    assert.ok(attempt2Enters >= 1, "a later verified-Yes Enter dismissed it");
  });

  it("PAINT-ORDER: needle before the ❯ marker → engage waits for the highlight", async () => {
    const pty = new FakePty();
    pty.onWrite = (data) => {
      if (data === DOWN) {
        setTimeout(() => pty.emit(TRUST_DIALOG_YES_SELECTED), 2);
        return;
      }
      setTimeout(() => pty.emit(WELCOME), 2);
    };
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    // Frame 1: the option TEXT paints (needle visible) — no ❯ yet. A
    // highlight-blind engage would send a bare Enter: fatal if this turns
    // out to be the default-No variant, as the next frame reveals.
    pty.emit("Quick safety check\nNo, exit\nYes, I trust this folder");
    await sleep(10);
    assert.deepEqual(pty.written, [], "no keys before the highlight is known");

    // Frame 2: the ❯ paints on No — now the watcher may engage, with Down.
    pty.emit("❯ No, exit");
    await waitFor(() => pty.watcherCount === 0, "engaged and dismissed");
    assert.equal(pty.written[0], DOWN, "first key is Down, never a bare Enter");
  });
});

/**
 * The onSettled contract: fired exactly ONCE at any terminal state. The
 * prompt-delivery receipt gates its warning windows on this signal, so a
 * watcher that settles twice would double-arm timers and one that never
 * settles would push the receipt onto its (much later) fallback.
 */
describe("startup watcher — onSettled contract", () => {
  it("fires once on the all-dialogs-dismissed path", async () => {
    const pty = new FakePty();
    let settled = 0;
    pty.onWrite = () => setTimeout(() => pty.emit(WELCOME), 5);
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      onSettled: () => settled++,
    });
    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 0, "watcher disposed");
    assert.equal(settled, 1);
    // Nothing later re-fires it.
    await sleep(80);
    assert.equal(settled, 1);
  });

  it("fires once on the hard-timeout path", async () => {
    const pty = new FakePty();
    let settled = 0;
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      timeoutMs: 60,
      onSettled: () => settled++,
    });
    await waitFor(() => settled === 1, "settled via hard timeout");
    await sleep(80);
    assert.equal(settled, 1);
  });

  it("fires once on the dead-PTY path", async () => {
    const pty = new FakePty();
    pty.throwOnWrite = true;
    let settled = 0;
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      onSettled: () => settled++,
    });
    pty.emit(TRUST_DIALOG); // engage → write throws → cleanup
    await waitFor(() => settled === 1, "settled via dead PTY");
    assert.equal(pty.watcherCount, 0);
  });

  it("a throwing onSettled is contained (never escapes into timer callbacks)", async () => {
    const pty = new FakePty();
    attachStartupWatcherCore(pty, OPTS, {
      expectChannels: false,
      ...FAST,
      timeoutMs: 40,
      onSettled: () => {
        throw new Error("listener bug");
      },
    });
    await waitFor(() => pty.watcherCount === 0, "disposed despite the throw");
  });
});

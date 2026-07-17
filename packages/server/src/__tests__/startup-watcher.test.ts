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
  "Do you trust the files in this folder?\nYes, I trust this folder\nNo, exit";
const CHANNELS_DIALOG =
  "WARNING: Loading development channels\nI am using this for local development";

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
    pty.onWrite = () => setTimeout(() => pty.emit("\x1b[2J> _ welcome"), 5);
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
    pty.onWrite = () => setTimeout(() => pty.emit("\x1b[2J> _ welcome"), 5);
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
    pty.emit("\x1b[2J> _ welcome");
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
    pty.onWrite = () => setTimeout(() => pty.emit("\x1b[2Jchannels gone"), 5);
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
        setTimeout(() => pty.emit(`\x1b[2J${CHANNELS_DIALOG}`), 5);
      else setTimeout(() => pty.emit("\x1b[2J> _ welcome"), 5);
    };
    pty.emit(TRUST_DIALOG);
    await waitFor(() => pty.watcherCount === 0, "both dialogs dismissed");

    assert.equal(pty.written.length, 2, "one Enter per dialog");
  });

  it("needle detection survives ANSI styling and \\r line discipline", async () => {
    const pty = new FakePty();
    pty.onWrite = () => setTimeout(() => pty.emit("\x1b[2J> _ welcome"), 5);
    attachStartupWatcherCore(pty, OPTS, { expectChannels: false, ...FAST });

    // The \r is stripped by the watcher's ANSI/control filter, rejoining the
    // needle text exactly as real CC TUI output does.
    pty.emit("\x1b[1m\x1b[32mYes, I trust\r this folder\x1b[0m");
    await waitFor(
      () => pty.watcherCount === 0,
      "ANSI-wrapped needle dismissed",
    );
    assert.deepEqual(pty.written, ["\r"], "ANSI-wrapped needle still detected");
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

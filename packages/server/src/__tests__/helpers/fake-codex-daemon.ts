/**
 * A fake Codex `app-server` daemon for exercising gateway/codexControl.ts.
 *
 * codexControl talks to the daemon through the GLOBAL WebSocket constructor, so
 * the cheapest honest seam is to swap that global for an in-memory JSON-RPC
 * peer — no `ws` dependency, no real ports, and the production code under test
 * is completely unmodified (it still builds frames, matches request ids, and
 * runs its own timeout logic).
 *
 * The peer implements only the four methods codexControl calls: `initialize`,
 * `thread/loaded/list`, `thread/read` and `turn/start`.
 */

export interface FakeCodexDaemon {
  /** Ground-truth thread status returned by `thread/read`. Mutate mid-test. */
  status: "idle" | "active";
  /** Thread ids returned by `thread/loaded/list`. Empty = no thread yet. */
  threadIds: string[];
  /** When true, `thread/read` answers with a JSON-RPC error (unreadable). */
  failThreadRead: boolean;
  /** Text of every turn injected via `turn/start`, in order. */
  readonly injected: string[];
  /** Restore the real global WebSocket. */
  restore(): void;
}

type Handler = ((ev: { data: string }) => void) | null;

export function installFakeCodexDaemon(): FakeCodexDaemon {
  const real = globalThis.WebSocket;
  // The returned handle IS the mutable state the fake peer reads, so a test
  // that flips `daemon.status` mid-flight is seen on the very next poll.
  const state: FakeCodexDaemon = {
    status: "idle",
    threadIds: ["thread-fake-1"],
    failThreadRead: false,
    injected: [],
    restore() {
      globalThis.WebSocket = real;
    },
  };

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: Handler = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;

    constructor(readonly url: string) {
      // Open on a macrotask so the caller has assigned its handlers first —
      // codexControl assigns them synchronously right after construction.
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }

    send(raw: string): void {
      let msg: {
        id?: number;
        method?: string;
        params?: { input?: { text?: string }[] };
      };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id === undefined) return; // a notification (e.g. "initialized")
      const reply = (body: Record<string, unknown>) =>
        setTimeout(() => {
          if (this.readyState === FakeWebSocket.OPEN)
            this.onmessage?.({
              data: JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }),
            });
        }, 0);

      switch (msg.method) {
        case "initialize":
          reply({ result: { serverInfo: { name: "fake-codex" } } });
          break;
        case "thread/loaded/list":
          reply({ result: { data: [...state.threadIds] } });
          break;
        case "thread/read":
          if (state.failThreadRead)
            reply({ error: { message: "no rollout for thread" } });
          else
            reply({ result: { thread: { status: { type: state.status } } } });
          break;
        case "turn/start":
          state.injected.push(msg.params?.input?.[0]?.text ?? "");
          reply({ result: {} });
          break;
        default:
          reply({ error: { message: `unknown method ${msg.method}` } });
      }
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return state;
}

/**
 * Capture console.log for the duration of `fn`, returning the lines.
 *
 * `fn` receives the LIVE accumulating array so a test can poll for the line it
 * expects (`waitUntil(() => lines.some(...))`) instead of sleeping a guessed
 * wall-clock budget and asserting afterwards. Fixed sleeps around timer-driven
 * effects are what produced this repo's CI-only flakes (see #280).
 */
export async function captureLogs(
  fn: (lines: string[]) => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn(lines);
  } finally {
    console.log = real;
  }
  return lines;
}

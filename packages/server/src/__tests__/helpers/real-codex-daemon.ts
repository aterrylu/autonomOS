/**
 * A REAL WebSocket server that impersonates a Codex `app-server` daemon.
 *
 * Distinct from `fake-codex-daemon.ts`, and deliberately so. That helper swaps
 * the GLOBAL `WebSocket` constructor for an in-memory peer — perfect for unit-
 * testing `codexControl`'s own logic, but it stubs the TRANSPORT, so anything
 * built on it is a unit test regardless of how much it wires up. This one binds
 * a real ephemeral loopback port and speaks a real RFC6455 handshake, so the
 * production client dials it exactly as it dials a live daemon. That is what
 * makes an integration test of the delivery path possible at all.
 *
 * It runs on `@hono/node-server` + `@hono/node-ws` — both already production
 * dependencies of this package (the server's own terminal socket uses them),
 * so the harness adds no dependency and no build step.
 *
 * SCOPE: protocol, never policy. The daemon answers the JSON-RPC methods
 * `codexControl` calls and records what it was asked to do. Every fault it can
 * inject is a thing a real daemon does on the wire — report a busy thread,
 * report no threads, reject a turn — never a statement about when WE may
 * inject. It has no model of our delivery mechanism and so cannot bake one into
 * a test that is supposed to outlive it.
 *
 * SELF-REPORTING: the harness records its own faults in `errors` (socket
 * errors, unparseable frames, post-bind server errors) and the suite asserts
 * that array is empty in teardown. A harness that hides its own breakage makes
 * every test built on it worthless — the symptom would be "production didn't
 * deliver" when the truth is "the fake daemon fell over".
 *
 * NO codex binary is involved. This is why the suite it backs runs in CI
 * unconditionally, on every `make check`, rather than behind an integration gate.
 */

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";

/** A `turn/start` the daemon accepted — the delivery ground truth. */
export interface RecordedTurn {
  readonly threadId: string;
  readonly text: string;
}

export interface RealCodexDaemon {
  /** `ws://127.0.0.1:<ephemeral>` — what the runtime stores as the agent's
   *  sidecar endpoint. Assigned once the listener reports its port. */
  endpoint: string;
  /** Thread status this daemon REPORTS on `thread/read`. Mutable mid-test:
   *  a protocol state, not a statement about when we may inject. */
  status: "idle" | "active" | "compacting";
  /** The thread this daemon reports on `thread/loaded/list`. */
  readonly threadId: string;
  /** While true, `turn/start` is answered with a JSON-RPC error — a daemon
   *  that is reachable but refuses the turn. Distinct from an unreachable
   *  socket, and the only condition under which the client's dequeue ORDERING
   *  is observable from out here. */
  rejectTurns: boolean;
  /** While true, `thread/loaded/list` reports no threads — a `--remote` TUI
   *  that never attached, so the agent has no conversation to inject into. */
  reportNoThreads: boolean;
  /** Turns the daemon ACCEPTED, in order. */
  readonly turns: RecordedTurn[];
  // The three counters below are written by the socket handlers, so they can't
  // be `readonly` — the handle IS the daemon's state, not a snapshot of it.
  // Tests only ever read them.
  /** `turn/start` calls received, including ones rejected via `rejectTurns` —
   *  so a test can wait on "the client tried" separately from "it landed". */
  turnAttempts: number;
  /** `thread/read`s served. Lets a test trigger on an observed protocol event
   *  instead of sleeping a guessed interval. */
  reads: number;
  /** Client connections accepted. One live Codex agent should produce exactly
   *  one — more means a controller is being rebuilt per message, which in
   *  production is N sockets and N status loops for one agent. */
  connections: number;
  /** Faults the HARNESS hit. Assert this is empty in teardown: a non-empty
   *  array means the daemon misbehaved, and any test failure alongside it is
   *  probably about the harness rather than the code under test. */
  readonly errors: unknown[];
  /** Close every socket and the listener. Await before the test ends, or the
   *  open handles keep the runner's process alive. */
  close(): Promise<void>;
}

interface JsonRpcRequest {
  id?: number;
  method?: string;
  params?: {
    threadId?: string;
    input?: { type?: string; text?: string }[];
  };
}

/** How long `close()` waits before reporting failure. A silently-stuck close
 *  would otherwise hang the whole run: node:test has no default hook timeout,
 *  so the runner child sits there with no output until CI's wall clock kills
 *  it — hours later, pointing at nothing. */
const CLOSE_TIMEOUT_MS = 2_000;

/** Start the daemon on an OS-assigned loopback port. */
export async function startRealCodexDaemon(): Promise<RealCodexDaemon> {
  const sockets = new Set<WSContext>();

  // The returned handle IS the mutable state the socket handlers read and
  // write — the same idiom as fake-codex-daemon.ts. Building it up front means
  // no wrapper object and no accessor plumbing: a test that flips `status`
  // mid-flight is seen on the very next read.
  const daemon: RealCodexDaemon = {
    endpoint: "", // real value assigned once the listener reports its port
    // Starts idle because that is a thread's resting state, not because idle
    // is when we are allowed to inject.
    status: "idle",
    threadId: "thread-integration-1",
    rejectTurns: false,
    reportNoThreads: false,
    turns: [],
    turnAttempts: 0,
    reads: 0,
    connections: 0,
    errors: [],
    close: async (): Promise<void> => {
      // Close the client sockets FIRST. `server.close()` only stops accepting
      // and then waits for existing connections to end — an open WebSocket
      // never ends on its own, so the other order hangs forever.
      for (const ws of sockets) {
        try {
          ws.close();
        } catch (err) {
          // Recorded rather than swallowed: a close that genuinely fails
          // leaves the socket open, which is exactly what makes the wait below
          // time out, and the cause would otherwise be invisible.
          daemon.errors.push(err);
        }
      }
      sockets.clear();
      const closed = new Promise<void>((resolve, reject) => {
        // `serve()` returns a union including Http2Server, which declares no
        // closeAllConnections — but the http/https members have it, and it is
        // the only way to evict a connection stuck mid-upgrade. If it is ever
        // absent the optional call no-ops silently, so the timeout below is
        // what turns that into a diagnosis instead of a hang.
        (
          server as { closeAllConnections?: () => void }
        ).closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `fake Codex daemon did not close within ${CLOSE_TIMEOUT_MS}ms`,
              ),
            ),
          CLOSE_TIMEOUT_MS,
        );
        timer.unref?.();
      });
      try {
        await Promise.race([closed, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  // codexControl connects to `ws://host:port` with no path, which is "/".
  app.get(
    "/",
    upgradeWebSocket(() => ({
      onOpen(_evt: Event, ws: WSContext) {
        daemon.connections++;
        sockets.add(ws);
      },
      onClose(_evt: unknown, ws: WSContext) {
        sockets.delete(ws);
      },
      // Without this, @hono/node-ws drops every raw socket error on the floor
      // (its handler is `events?.onError?.(...)`, a no-op when undefined). A
      // frame `ws` rejects would then make the client's RPC hang to its 30s
      // timeout while the harness said nothing at all.
      onError(evt: unknown) {
        daemon.errors.push(evt);
      },
      onMessage(evt: MessageEvent, ws: WSContext) {
        let msg: JsonRpcRequest;
        try {
          msg = JSON.parse(String(evt.data)) as JsonRpcRequest;
        } catch (err) {
          // A real daemon ignores garbage rather than closing — but it must not
          // be invisible HERE. If the client's framing ever changes, every RPC
          // hangs and the suite reports "production didn't deliver". Production
          // logs this on its own side too (codexControl's framingErrorLogged).
          daemon.errors.push(err);
          return;
        }
        // No id → a notification (`initialized`). Never answer one: a reply
        // carrying id:undefined would be a protocol violation the client would
        // have to tolerate, which is not a behavior worth teaching a test.
        if (msg.id === undefined) return;

        const reply = (body: Record<string, unknown>): void =>
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));

        switch (msg.method) {
          case "initialize":
            reply({
              result: {
                serverInfo: { name: "fake-codex-app-server", version: "0.0.0" },
              },
            });
            break;
          case "thread/loaded/list":
            reply({
              result: { data: daemon.reportNoThreads ? [] : [daemon.threadId] },
            });
            break;
          case "thread/read":
            daemon.reads++;
            reply({ result: { thread: { status: { type: daemon.status } } } });
            break;
          case "turn/start":
            daemon.turnAttempts++;
            if (daemon.rejectTurns) {
              reply({ error: { code: -32000, message: "turn rejected" } });
              break;
            }
            daemon.turns.push({
              threadId: msg.params?.threadId ?? "",
              text: msg.params?.input?.[0]?.text ?? "",
            });
            reply({ result: {} });
            break;
          default:
            // Answer unknown methods with an ERROR rather than silence, so a
            // client that starts calling something new fails loudly here
            // instead of hanging until its 30s RPC timeout.
            reply({
              error: { code: -32601, message: `unknown method ${msg.method}` },
            });
        }
      },
    })),
  );

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  injectWebSocket(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  // Re-point the error handler now that the bind promise is settled. Left as
  // it was, every later server error (EMFILE, a failure during upgrade) would
  // call `reject` on an already-resolved promise — a silent no-op — and the
  // test would fail later on an unrelated timeout.
  server.removeAllListeners("error");
  server.on("error", (err) => daemon.errors.push(err));

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fake Codex daemon did not report a numeric port");
  daemon.endpoint = `ws://127.0.0.1:${address.port}`;
  return daemon;
}

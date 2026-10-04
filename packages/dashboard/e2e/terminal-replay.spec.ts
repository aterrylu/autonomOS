import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { DecModeTracker } from "../../server/src/agents/terminalModes";
import { type MockAgent, mockApi } from "./mocks";

/**
 * CI regression guard for Terry's two terminal bugs (2026-10-01), in a REAL
 * xterm in a real Chromium (rAF runs, so wheel scrolling is real):
 *   A — "Codex panes freeze: I can't scroll" / after the first fix "the wheel
 *       walks my prompt history instead of scrolling the transcript".
 *   B — "a Claude terminal blacked out except the part that refreshes"
 *       (CLAUDE_CODE_NO_FLICKER=1).
 * Ground truth (ADR-135): xterm.js turns the wheel into ↑/↓ on ANY buffer
 * without scrollback (it ignores ?1007), and in Codex ↑ walks prompt history.
 * Codex 0.159 defaulted to the alternate screen, so it is now spawned inline
 * (tui.alternate_screen="never"): its transcript is xterm scrollback, the
 * wheel scrolls it, and NO bytes reach the agent. Claude no_flicker is an
 * alternate screen WITH mouse tracking: the wheel must reach Claude as mouse
 * reports. The mocked socket delivers exactly what the real server builds
 * (the same DecModeTracker preamble, begin/end markers) from REAL captured
 * streams.
 *
 * Mutation harness (each must FAIL a test, naming the symptom):
 *   E2E_OLD_REPLAY=1  pre-fix replay (no preamble, no geometry marker)
 *   E2E_FORCE_ALT=1   the wrong first fix: Codex replayed onto the alt screen
 */

const OLD = process.env.E2E_OLD_REPLAY === "1";
const FORCE_ALT = process.env.E2E_FORCE_ALT === "1";
const NOW = Date.now();

const fixture = (name: string): string[] =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `../../server/src/__tests__/fixtures/tui-stream-${name}.json`,
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );

const BEGIN = (cols: number, rows: number) =>
  `\x1b]7777;autonomos-replay-begin;cols=${cols};rows=${rows}\x07`;
// input-ack=1 keeps the pane in acked mode, so the mocked-closed status socket
// can't cut it mid-test (a stale heartbeat never cuts an acked pane).
const END = "\x1b]7777;autonomos-replay-end;input-ack=1\x07";

/** What the server sends a pane on connect, given a buffer the 1MB trim cut
 *  at `cut` (chunks before it are gone). */
function serverReplay(
  chunks: string[],
  cut: number,
  geom: { cols: number; rows: number },
): string[] {
  const head = new DecModeTracker();
  for (const c of chunks.slice(0, cut)) head.feed(c);
  const frames: string[] = [];
  if (!OLD) frames.push(BEGIN(geom.cols, geom.rows));
  const forced = FORCE_ALT ? "\x1b[?1049h\x1b[?1007h" : "";
  frames.push(forced + (OLD ? "" : head.preamble()) + chunks.slice(cut).join(""));
  frames.push(END);
  return frames;
}

function agent(id: string, name: string, provider: string): MockAgent {
  return {
    id,
    name,
    status: "running",
    workingDirectory: "/Users/dev/work",
    provider,
    providerSessionId: id,
    managerId: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
  };
}

/** A terminal socket that replays the given frames on open, acks every acked
 *  input frame, and records what the pane sent (decoded to text). Installed
 *  AFTER mockApi's always-closed stub, so it wins for /ws/terminal/ URLs. */
async function installTerminalSocket(
  page: Page,
  replays: Record<string, string[]>,
) {
  await page.addInitScript((replaysArg) => {
    const Stub = window.WebSocket;
    const sent: string[] = [];
    (window as unknown as { __termSent: string[] }).__termSent = sent;
    class TerminalSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      url: string;
      readyState = 0;
      bufferedAmount = 0;
      extensions = "";
      protocol = "";
      binaryType: BinaryType = "blob";
      onopen: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(url: string | URL) {
        super();
        this.url = String(url);
        const id = /\/ws\/terminal\/([^?]+)/.exec(this.url)?.[1] ?? "";
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          for (const data of replaysArg[id] ?? []) {
            this.onmessage?.(new MessageEvent("message", { data }));
          }
        }, 0);
      }
      send(d: string | ArrayBufferView | ArrayBuffer) {
        if (typeof d === "string") {
          sent.push(d);
          return;
        }
        const u8 =
          d instanceof ArrayBuffer
            ? new Uint8Array(d)
            : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
        if (u8[0] !== 0x01 || u8.length < 9) return;
        sent.push(new TextDecoder().decode(u8.subarray(9)));
        const ack = new ArrayBuffer(5);
        new DataView(ack).setUint8(0, 0x02);
        new DataView(ack).setUint32(1, new DataView(u8.buffer, u8.byteOffset).getUint32(1));
        setTimeout(() => this.onmessage?.(new MessageEvent("message", { data: ack })), 0);
      }
      close() {
        this.readyState = 3;
      }
    }
    window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
      return String(url).includes("/ws/terminal/")
        ? new TerminalSocket(url)
        : new Stub(url, protocols);
    } as unknown as typeof WebSocket;
    Object.assign(window.WebSocket, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3,
    });
  }, replays);
}

/** Open the agent's pane at boot (persisted activePane), not via the sidebar:
 *  the mocked org tree only knows the stock agents. */
async function openPaneAtBoot(page: Page, id: string) {
  await page.addInitScript(
    (agentId) =>
      localStorage.setItem(
        "autonomos",
        JSON.stringify({
          state: { activePane: { type: "session", id: agentId } },
          version: 0,
        }),
      ),
    id,
  );
}

/** Alternate-buffer rows of a live terminal, as text. */
function altRows(page: Page, id: string) {
  return page.evaluate((agentId) => {
    const get = (
      window as unknown as {
        __autonomosTerminal: (id: string) =>
          | {
              terminal: {
                buffer: {
                  active: {
                    type: string;
                    length: number;
                    getLine: (
                      y: number,
                    ) => { translateToString: (trim: boolean) => string } | undefined;
                  };
                };
              };
            }
          | undefined;
      }
    ).__autonomosTerminal;
    const buf = get(agentId)?.terminal.buffer.active;
    if (!buf) return null;
    const rows: string[] = [];
    for (let y = 0; y < Math.min(buf.length, 12); y++) {
      rows.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    return { type: buf.type, rows };
  }, id);
}

/** Viewport position + buffer type of a live terminal. */
function viewport(page: Page, id: string) {
  return page.evaluate((agentId) => {
    const get = (
      window as unknown as {
        __autonomosTerminal: (id: string) =>
          | {
              terminal: {
                buffer: {
                  active: { type: string; baseY: number; viewportY: number };
                };
              };
            }
          | undefined;
      }
    ).__autonomosTerminal;
    const b = get(agentId)?.terminal.buffer.active;
    return b ? { type: b.type, baseY: b.baseY, viewportY: b.viewportY } : null;
  }, id);
}

const ARROW_OR_MOUSE = /\x1b\[A|\x1bOA|\x1b\[B|\x1bOB|\x1b\[<6[45];/;

async function wheelUpOverTerminal(page: Page) {
  const box = (await page.locator(".xterm").first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    (window as unknown as { __termSent: string[] }).__termSent.length = 0;
  });
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(30);
  }
}

test("A: Codex (inline, as spawned) — after a trimmed replay the wheel scrolls the TRANSCRIPT and sends nothing to the agent (not ↑ = prompt history)", async ({
  page,
}) => {
  const INLINE = fixture("codex-inline");
  const id = "agent-codex-replay-01";
  await mockApi(page, { agents: [agent(id, "Codex Replay", "codex")] });
  await installTerminalSocket(page, {
    // head-trimmed: a long session's buffer lost its start
    [id]: serverReplay(INLINE, Math.floor(INLINE.length / 3), {
      cols: 141,
      rows: 49,
    }),
  });
  await openPaneAtBoot(page, id);
  await page.goto("/");
  await expect(page.locator(".xterm").first()).toBeVisible();
  await expect
    .poll(async () => (await viewport(page, id))?.baseY ?? 0, {
      message:
        "Codex freeze/history-walk: no scrollback, the pane is on the ALTERNATE screen (wheel → ↑ = prompt history)",
    })
    .toBeGreaterThan(20);
  const before = (await viewport(page, id))!;
  expect(
    before.type,
    "Codex freeze/history-walk: the replay put the pane on the ALTERNATE screen (wheel → ↑ = prompt history)",
  ).toBe("normal");

  await wheelUpOverTerminal(page);
  await expect
    .poll(async () => (await viewport(page, id))?.viewportY, {
      message:
        "Codex freeze: the wheel did not scroll the transcript (viewport didn't move)",
    })
    .toBeLessThan(before.viewportY);
  const sent = await page.evaluate(
    () => (window as unknown as { __termSent: string[] }).__termSent,
  );
  expect(
    sent.filter((d) => ARROW_OR_MOUSE.test(d)),
    "Codex history-walk: the wheel sent arrow keys / mouse reports to the agent",
  ).toEqual([]);
});

test("C: Claude no_flicker — after a trimmed replay the wheel reaches CLAUDE as mouse reports (it scrolls itself), never as arrow keys", async ({
  page,
}) => {
  const CLAUDE = fixture("claude");
  // Trimmed past the chunk that turned mouse tracking on.
  const cut = CLAUDE.findIndex((c) => c.includes("\x1b[?1006h")) + 1;
  expect(cut).toBeGreaterThan(0);
  const id = "agent-claude-mouse-01";
  await mockApi(page, { agents: [agent(id, "Claude Mouse", "claude-code")] });
  await installTerminalSocket(page, {
    [id]: serverReplay(CLAUDE, cut, { cols: 141, rows: 49 }),
  });
  await openPaneAtBoot(page, id);
  await page.goto("/");
  await expect(page.locator(".xterm").first()).toBeVisible();
  await expect
    .poll(async () => (await viewport(page, id))?.type, {
      message:
        "no_flicker: the trimmed replay left the pane OFF the alternate screen (?1049h not restored)",
    })
    .toBe("alternate");
  await wheelUpOverTerminal(page);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __termSent: string[] }).__termSent.some((d) =>
            /\x1b\[<64;/.test(d),
          ),
        ),
      {
        message:
          "no_flicker: the wheel did not reach Claude as a mouse report (mouse tracking not restored)",
      },
    )
    .toBe(true);
  const sent = await page.evaluate(
    () => (window as unknown as { __termSent: string[] }).__termSent,
  );
  expect(
    sent.filter((d) => /\x1b\[A|\x1bOA/.test(d)),
    "no_flicker: the wheel was turned into arrow keys",
  ).toEqual([]);
});

test("B: fresh pane — a full-screen replay is parsed at the PTY's size, not xterm's default (Terry's no_flicker 'blackout')", async ({
  page,
}) => {
  // An alternate-screen frame drawn for a 400-column PTY: a 300-cell run on
  // one row, "end" on the next. Parsed at the PTY's size the run fits on its
  // row; parsed at ANY narrower size (80 default, or a ~150-col fitted pane)
  // it wraps into the next row. Whatever the fit timing, only the fix keeps
  // that row to just "end".
  const stream = [
    "\x1b[?1049h\x1b[H\x1b[2J",
    `\x1b[5;1H${"X".repeat(300)}`,
    "\x1b[6;1Hend",
  ];
  const id = "agent-claude-replay-01";
  await mockApi(page, { agents: [agent(id, "Claude Replay", "claude-code")] });
  await installTerminalSocket(page, {
    [id]: serverReplay(stream, 0, { cols: 400, rows: 30 }),
  });
  await openPaneAtBoot(page, id);
  await page.goto("/");
  await expect(page.locator(".xterm").first()).toBeVisible();
  await expect
    .poll(async () => (await altRows(page, id))?.rows[5]?.startsWith("end"))
    .toBe(true);
  const grid = (await altRows(page, id))!;
  expect(
    grid.rows[5],
    "no_flicker blackout: the replay was parsed at the wrong width (content wrapped/garbled; the rest of the pane never repaints)",
  ).toBe("end");
});

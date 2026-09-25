import assert from "node:assert/strict";
// Config-dir isolation: transitively resolves the config dir; the configDir
// test-escape guard refuses the production dir from a test process.
import { mkdtempSync as __mkdtemp, mkdtempSync, rmSync } from "node:fs";
import { tmpdir as __tmpdir, tmpdir } from "node:os";
import { join as __join, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentDelta } from "@autonomos/core";
import type { WSContext } from "hono/ws";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { onAgentDelta } from "../events/agents.js";
import {
  _resetMessageLogForTesting,
  FULL_MAX,
  forgetAgentMessages,
  getAgentMessageStats,
  PREVIEW_MAX,
  plainText,
  previewOf,
  RING_SIZE,
  recordAcceptedMessage,
} from "../gateway/messageLog.js";
import {
  registerSessionClient,
  routeMessage,
  unregisterSessionClient,
} from "../gateway/router.js";

process.env.AUTONOMOS_CONFIG_DIR = __mkdtemp(__join(__tmpdir(), "aos-iso-"));

type Routed = Extract<AgentDelta, { type: "message.routed" }>;

function captureRouted(): { events: Routed[]; stop: () => void } {
  const events: Routed[] = [];
  const stop = onAgentDelta((e) => {
    if (e.type === "message.routed") events.push(e);
  });
  return { events, stop };
}

describe("messageLog — sanitizing what the dashboard may show", () => {
  it("strips ANSI colors, OSC hyperlinks and other control characters", () => {
    assert.equal(plainText("\x1b[32mgreen\x1b[0m text"), "green text");
    assert.equal(
      plainText("see \x1b]8;;https://x.test\x07the link\x1b]8;;\x07 now"),
      "see the link now",
    );
    assert.equal(plainText("bell\x07 and\x00 nul"), "bell and nul");
  });

  it("strips markdown syntax and keeps the words", () => {
    assert.equal(plainText("**PR #412** is `ready`"), "PR #412 is ready");
    assert.equal(plainText("# Title\n> quoted"), "Title quoted");
    assert.equal(plainText("see [the ADR](https://x.test/adr)"), "see the ADR");
    assert.equal(plainText("_emph_ and *stars*"), "emph and stars");
  });

  it("previews are ONE line, capped with an ellipsis, surrogate-safe", () => {
    assert.equal(previewOf("line one\nline two"), "line one line two");
    const long = "x".repeat(200);
    const p = previewOf(long);
    assert.equal(Array.from(p).length, PREVIEW_MAX);
    assert.ok(p.endsWith("…"));
    // 70 emoji: a code-unit slice would split a surrogate pair.
    const emoji = previewOf("😀".repeat(70));
    assert.equal(Array.from(emoji).length, PREVIEW_MAX);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji));
  });

  it("stays FAST on hostile or huge input (runs on the event loop)", () => {
    // Measured before the fix: 100k-char inputs like these took 4–15s each.
    const n = 100_000;
    for (const input of [
      "[a](".repeat(n),
      " \n".repeat(n),
      "\n".repeat(n),
      "[".repeat(n),
      "> ".repeat(n),
      "x".repeat(n * 10),
    ]) {
      const t0 = performance.now();
      previewOf(input);
      const ms = performance.now() - t0;
      assert.ok(
        ms < 250,
        `took ${ms.toFixed(0)}ms on ${JSON.stringify(input.slice(0, 8))}…`,
      );
    }
  });

  it("truncating the input never leaves half a surrogate pair", () => {
    const text = plainText(`${"a".repeat(3999)}😀tail`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text));
  });

  it("a markup-looking message is plain text, not HTML (rendering stays textContent)", () => {
    // The server doesn't escape; the dashboard renders with textContent. This
    // pins that nothing here tries to "interpret" markup either.
    assert.equal(
      previewOf("<img src=x onerror=alert(1)>"),
      "<img src=x onerror=alert(1)>",
    );
  });
});

describe("messageLog — recording an accepted message", () => {
  beforeEach(() => _resetMessageLogForTesting());

  it("broadcasts ONLY the capped preview, never the full text", () => {
    const { events, stop } = captureRouted();
    const secretTail = "TAIL-THAT-MUST-NOT-BROADCAST";
    recordAcceptedMessage({
      from: "a",
      fromName: "Alice",
      to: "b",
      toName: "Bob",
      content: `${"hello ".repeat(20)}${secretTail}`,
      now: 1000,
    });
    stop();
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.from, "a");
    assert.equal(e.to, "b");
    assert.equal(e.fromName, "Alice");
    assert.equal(e.toName, "Bob");
    assert.equal(e.ts, 1000);
    assert.ok(Array.from(e.preview).length <= PREVIEW_MAX);
    assert.ok(!JSON.stringify(e).includes(secretTail));
  });

  it("counts sent, received and per-peer traffic, busiest peer first", () => {
    const send = (from: string, to: string) =>
      recordAcceptedMessage({
        from,
        fromName: from,
        to,
        toName: to,
        content: "hi",
      });
    send("a", "b");
    send("a", "b");
    send("b", "a");
    send("a", "c");
    const a = getAgentMessageStats("a");
    assert.equal(a.sent, 3);
    assert.equal(a.received, 1);
    assert.deepEqual(
      a.peers.map((p) => [p.name, p.sent, p.received]),
      [
        ["b", 2, 1],
        ["c", 1, 0],
      ],
    );
    assert.equal(getAgentMessageStats("c").received, 1);
  });

  it("keeps the newest RING_SIZE messages per agent, newest first, text capped at FULL_MAX", () => {
    for (let i = 0; i < RING_SIZE + 5; i++) {
      recordAcceptedMessage({
        from: "a",
        fromName: "A",
        to: "b",
        toName: "B",
        content: `m${i} ${"y".repeat(FULL_MAX)}`,
        now: i,
      });
    }
    // Ask for MORE than the ring holds: an unbounded ring would return them.
    const b = getAgentMessageStats("b", RING_SIZE + 5);
    assert.equal(b.recent.length, RING_SIZE);
    assert.equal(b.recent[0].ts, RING_SIZE + 4); // newest first
    assert.ok(b.recent.every((m) => Array.from(m.text).length <= FULL_MAX));
    assert.equal(getAgentMessageStats("b", 3).recent.length, 3);
    assert.equal(getAgentMessageStats("b", 0).recent.length, 0);
  });

  it("a schedule sender records as from=null with its name, and counts only on the recipient", () => {
    const { events, stop } = captureRouted();
    recordAcceptedMessage({
      from: null,
      fromName: "Schedule nightly",
      to: "b",
      toName: "B",
      content: "run the triage",
    });
    stop();
    assert.equal(events[0].from, null);
    assert.equal(events[0].fromName, "Schedule nightly");
    const b = getAgentMessageStats("b");
    assert.equal(b.received, 1);
    assert.deepEqual(b.peers[0], {
      id: null,
      name: "Schedule nightly",
      sent: 0,
      received: 1,
    });
  });

  it("forgets a deleted agent", () => {
    recordAcceptedMessage({
      from: "a",
      fromName: "A",
      to: "b",
      toName: "B",
      content: "x",
    });
    forgetAgentMessages("b");
    assert.deepEqual(getAgentMessageStats("b"), {
      sent: 0,
      received: 0,
      peers: [],
      recent: [],
    });
  });
});

describe("messageLog — wired into routeMessage's accept points only", () => {
  let isolatedDir: string;
  const SENDER = "5e2de100-0000-4000-8000-00000000aaaa";

  function seed(
    id: string,
    name: string,
    provider: "claude-code" | "gemini-cli",
  ) {
    insertAgent(
      buildAgent({
        id: id as never,
        name,
        workingDirectory: "/tmp",
        provider,
        providerSessionId: id,
        permissionMode: "ask",
      }),
    );
  }

  beforeEach(() => {
    isolatedDir = mkdtempSync(join(tmpdir(), "autonomos-msglog-"));
    _setConfigDirForTesting(isolatedDir);
    _resetCacheForTesting();
    _resetMessageLogForTesting();
    seed(SENDER, "Sender", "claude-code");
  });

  afterEach(() => {
    _resetConfigDirForTesting();
    _resetCacheForTesting();
    rmSync(isolatedDir, { recursive: true, force: true });
  });

  it("a Claude Code delivery that lands on an OPEN socket is recorded once", async () => {
    const id = "c1ad0000-0000-4000-8000-0000000000c1";
    seed(id, "LiveClaude", "claude-code");
    const ws = {
      readyState: 1,
      send: () => {},
    } as unknown as WSContext;
    registerSessionClient(id, ws);
    const { events, stop } = captureRouted();
    const err = await routeMessage(
      "agent://LiveClaude",
      "**ping** now",
      SENDER,
    );
    stop();
    unregisterSessionClient(ws);
    assert.equal(err, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].to, id);
    assert.equal(events[0].toName, "LiveClaude");
    assert.equal(events[0].from, SENDER);
    assert.equal(events[0].preview, "ping now");
    assert.equal(getAgentMessageStats(id).received, 1);
  });

  it("a refused delivery (CLOSING socket) records NOTHING — no phantom traffic", async () => {
    const id = "c1ad0000-0000-4000-8000-0000000000c2";
    seed(id, "ClosingClaude", "claude-code");
    const ws = { readyState: 2, send: () => {} } as unknown as WSContext;
    registerSessionClient(id, ws);
    const { events, stop } = captureRouted();
    const err = await routeMessage("agent://ClosingClaude", "ping", SENDER);
    stop();
    unregisterSessionClient(ws);
    assert.ok(err);
    assert.equal(events.length, 0);
    assert.equal(getAgentMessageStats(id).received, 0);
  });

  it("a Gemini hand-off QUEUE accept is recorded (queued = accepted, ADR-064)", async () => {
    const id = "9e3d0000-0000-4000-8000-0000000000c3";
    seed(id, "Gem", "gemini-cli");
    const { events, stop } = captureRouted();
    const err = await routeMessage("agent://Gem", "please review", SENDER);
    stop();
    assert.equal(err, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].to, id);
  });

  it("an unknown recipient records nothing", async () => {
    const { events, stop } = captureRouted();
    const err = await routeMessage("agent://Nobody", "hi", SENDER);
    stop();
    assert.ok(err);
    assert.equal(events.length, 0);
  });
});

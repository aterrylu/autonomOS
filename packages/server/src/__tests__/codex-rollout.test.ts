/**
 * readLastCodexAgentMessage / extractAssistantReply — extract a Codex agent's
 * final reply (message + the rollout line's timestamp) from its rollout JSONL
 * (the source for the F3 AgentMessage unread notification).
 *
 * The PRIMARY fixture is derived from a REAL codex 0.15x rollout — the reply is a
 * `response_item` with `payload.type:"message"`, `role:"assistant"` and text in
 * `content:[{type:"output_text",text}]`. F3 originally parsed the OLDER
 * `event_msg/agent_message` shape, which codex had already dropped, so the reader
 * silently returned null for every real reply and the unread badge never moved.
 * The old shape is retained ONLY as a back-compat case. Pins: the new shape,
 * old-shape back-compat, role filtering (only `assistant`), newest rollout by
 * thread id, LAST reply, its ts (dedup identity), truncation, garbled-tail
 * tolerance, and null (never throws) on no rollout / no reply / bad file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  _resetCodexRolloutCacheForTesting,
  readLastCodexAgentMessage,
} from "../gateway/codexRollout.js";

let home: string;
let sessionsDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-rollout-"));
  process.env.CODEX_HOME = home;
  sessionsDir = join(home, "sessions", "2026", "09", "18");
  mkdirSync(sessionsDir, { recursive: true });
  _resetCodexRolloutCacheForTesting(); // the path cache persists across cases
});
afterEach(() => {
  delete process.env.CODEX_HOME;
  _resetCodexRolloutCacheForTesting();
  rmSync(home, { recursive: true, force: true });
});

function writeRollout(threadId: string, lines: unknown[]): void {
  const body = lines.map((l) => JSON.stringify(l)).join("\n");
  writeFileSync(
    join(sessionsDir, `rollout-2026-09-18T00-00-00-${threadId}.jsonl`),
    `${body}\n`,
  );
}

/** CURRENT codex 0.15x reply line — derived verbatim from a real rollout: a
 *  `response_item` message, role assistant, text in an `output_text` content
 *  item. This is the shape the reader MUST handle. */
const assistantMsg = (text: string, ts = "2026-09-18T00:00:01.000Z") => ({
  timestamp: ts,
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_abc123",
    role: "assistant",
    content: [{ type: "output_text", text }],
    phase: "final_answer",
  },
});

/** LEGACY (≤0.144) reply line — kept only for the back-compat path. */
const agentMsg = (message: string, ts = "2026-09-18T00:00:01.000Z") => ({
  timestamp: ts,
  type: "event_msg",
  payload: { type: "agent_message", message },
});

describe("readLastCodexAgentMessage — current codex reply shape", () => {
  it("reads the CURRENT response_item/message/assistant shape (the real one)", () => {
    const tid = "019ee3dc-c794-7842-a46d-b72519b13a7a";
    writeRollout(tid, [
      { type: "session_meta", payload: { id: tid, cwd: "/x" } },
      assistantMsg("first reply", "2026-09-18T00:00:01.000Z"),
      { type: "event_msg", payload: { type: "token_count" } },
      assistantMsg("the final reply", "2026-09-18T00:00:09.000Z"),
      { type: "event_msg", payload: { type: "task_complete" } },
    ]);
    assert.deepEqual(readLastCodexAgentMessage(tid), {
      message: "the final reply",
      ts: "2026-09-18T00:00:09.000Z",
    });
  });

  it("only counts role:assistant — developer/user messages are ignored", () => {
    const tid = "ffffffff-0000-4000-8000-000000000000";
    const userMsg = (text: string) => ({
      timestamp: "2026-09-18T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    writeRollout(tid, [
      assistantMsg("the assistant answer", "2026-09-18T00:00:01.000Z"),
      // A later USER turn must NOT be mistaken for the reply.
      userMsg("a follow-up question from the human"),
    ]);
    assert.equal(
      readLastCodexAgentMessage(tid)?.message,
      "the assistant answer",
    );
  });

  it("joins multi-part output_text content", () => {
    const tid = "10101010-0000-4000-8000-000000000000";
    writeRollout(tid, [
      {
        timestamp: "2026-09-18T00:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "part one " },
            { type: "output_text", text: "part two" },
          ],
        },
      },
    ]);
    assert.equal(readLastCodexAgentMessage(tid)?.message, "part one part two");
  });

  it("BACK-COMPAT: still reads the legacy event_msg/agent_message shape", () => {
    const tid = "20202020-0000-4000-8000-000000000000";
    writeRollout(tid, [agentMsg("legacy reply", "2026-09-18T00:00:04.000Z")]);
    assert.deepEqual(readLastCodexAgentMessage(tid), {
      message: "legacy reply",
      ts: "2026-09-18T00:00:04.000Z",
    });
  });

  it("returns null when no rollout matches the thread id", () => {
    writeRollout("aaaaaaaa-0000-4000-8000-000000000000", [assistantMsg("hi")]);
    assert.equal(readLastCodexAgentMessage("does-not-exist"), null);
  });

  it("returns null when the rollout has no assistant reply", () => {
    const tid = "bbbbbbbb-0000-4000-8000-000000000000";
    writeRollout(tid, [
      { type: "session_meta", payload: { id: tid } },
      { type: "event_msg", payload: { type: "task_started" } },
    ]);
    assert.equal(readLastCodexAgentMessage(tid), null);
  });

  it("truncates a very long reply", () => {
    const tid = "cccccccc-0000-4000-8000-000000000000";
    writeRollout(tid, [assistantMsg("x".repeat(5000))]);
    const out = readLastCodexAgentMessage(tid);
    assert.ok(
      out && out.message.length <= 1001,
      "truncated to the cap + ellipsis",
    );
    assert.ok(out?.message.endsWith("…"), "marks truncation");
  });

  it("tolerates a garbled trailing line (returns the last valid reply)", () => {
    const tid = "dddddddd-0000-4000-8000-000000000000";
    // A crash mid-write can leave a partial final line; the scan must skip it.
    const good = JSON.stringify(
      assistantMsg("clean reply", "2026-09-18T00:00:05.000Z"),
    );
    writeFileSync(
      join(sessionsDir, `rollout-2026-09-18T00-00-00-${tid}.jsonl`),
      `${good}\n{"type":"response_item","payload":{"type":"mess`,
    );
    assert.equal(readLastCodexAgentMessage(tid)?.message, "clean reply");
  });

  it("falls back to a line-based ts when the rollout line has no timestamp", () => {
    const tid = "eeeeeeee-0000-4000-8000-000000000000";
    writeRollout(tid, [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "no-ts reply" }],
        },
      },
    ]);
    const out = readLastCodexAgentMessage(tid);
    assert.equal(out?.message, "no-ts reply");
    assert.ok(
      out?.ts.startsWith("line:"),
      "synthetic ts so dedup never collapses",
    );
  });
});

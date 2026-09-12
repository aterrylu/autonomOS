/**
 * readLastCodexAgentMessage — extracts a Codex agent's final reply (message + the
 * rollout line's timestamp) from its rollout JSONL (the source for the F3
 * AgentMessage notification). Pins: newest rollout by thread id, the LAST
 * agent_message, its ts (occurrence identity for dedup), truncation, garbled-tail
 * tolerance, and null (never throws) when there's no rollout / no message / bad file.
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
  sessionsDir = join(home, "sessions", "2026", "09", "10");
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
    join(sessionsDir, `rollout-2026-09-10T00-00-00-${threadId}.jsonl`),
    `${body}\n`,
  );
}
const agentMsg = (message: string, ts = "2026-09-10T00:00:01.000Z") => ({
  timestamp: ts,
  type: "event_msg",
  payload: { type: "agent_message", message },
});

describe("readLastCodexAgentMessage", () => {
  it("returns the LAST agent_message + its timestamp for a thread", () => {
    const tid = "019ee3dc-c794-7842-a46d-b72519b13a7a";
    writeRollout(tid, [
      { type: "session_meta", payload: { id: tid, cwd: "/x" } },
      agentMsg("first reply", "2026-09-10T00:00:01.000Z"),
      { type: "event_msg", payload: { type: "token_count" } },
      agentMsg("the final reply", "2026-09-10T00:00:09.000Z"),
    ]);
    assert.deepEqual(readLastCodexAgentMessage(tid), {
      message: "the final reply",
      ts: "2026-09-10T00:00:09.000Z",
    });
  });

  it("returns null when no rollout matches the thread id", () => {
    writeRollout("aaaaaaaa-0000-4000-8000-000000000000", [agentMsg("hi")]);
    assert.equal(readLastCodexAgentMessage("does-not-exist"), null);
  });

  it("returns null when the rollout has no agent_message", () => {
    const tid = "bbbbbbbb-0000-4000-8000-000000000000";
    writeRollout(tid, [
      { type: "session_meta", payload: { id: tid } },
      { type: "event_msg", payload: { type: "task_started" } },
    ]);
    assert.equal(readLastCodexAgentMessage(tid), null);
  });

  it("truncates a very long reply", () => {
    const tid = "cccccccc-0000-4000-8000-000000000000";
    writeRollout(tid, [agentMsg("x".repeat(5000))]);
    const out = readLastCodexAgentMessage(tid);
    assert.ok(
      out && out.message.length <= 1001,
      "truncated to the cap + ellipsis",
    );
    assert.ok(out?.message.endsWith("…"), "marks truncation");
  });

  it("tolerates a garbled trailing line (returns the last valid agent_message)", () => {
    const tid = "dddddddd-0000-4000-8000-000000000000";
    // A crash mid-write can leave a partial final line; the scan must skip it.
    const good = JSON.stringify(
      agentMsg("clean reply", "2026-09-10T00:00:05.000Z"),
    );
    writeFileSync(
      join(sessionsDir, `rollout-2026-09-10T00-00-00-${tid}.jsonl`),
      `${good}\n{"type":"event_msg","payload":{"type":"agent_mess`,
    );
    assert.equal(readLastCodexAgentMessage(tid)?.message, "clean reply");
  });

  it("falls back to a line-based ts when the rollout line has no timestamp", () => {
    const tid = "eeeeeeee-0000-4000-8000-000000000000";
    writeRollout(tid, [
      {
        type: "event_msg",
        payload: { type: "agent_message", message: "no-ts reply" },
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

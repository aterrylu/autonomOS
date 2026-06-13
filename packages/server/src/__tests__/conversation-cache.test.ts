import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConversation } from "../routes/conversation.js";

const TEST_DIR = join(tmpdir(), `autonomos-test-conversation-${randomUUID()}`);

// A minimal valid Claude Code transcript: one user prompt + one assistant turn.
function transcript(text: string): string {
  return [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: text },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    }),
  ].join("\n");
}

describe("loadConversation cache", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns the SAME payload object on a cache hit (same mtime)", () => {
    const file = join(TEST_DIR, "s.jsonl");
    writeFileSync(file, transcript("hello"));
    const { mtimeMs } = statSync(file);

    const first = loadConversation("sess-a", file, mtimeMs);
    const second = loadConversation("sess-a", file, mtimeMs);

    // Reference equality proves the second call skipped read + parse.
    assert.equal(first, second);
    assert.ok(first.turns.length > 0);
    assert.equal(first.entryCount, 2);
  });

  it("re-parses (new object) when the file mtime changes", () => {
    const file = join(TEST_DIR, "s.jsonl");
    writeFileSync(file, transcript("hello"));
    const first = loadConversation("sess-b", file, statSync(file).mtimeMs);

    // Append + bump mtime forward to simulate a live transcript growing.
    writeFileSync(file, `${transcript("hello")}\n${transcript("again")}`);
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    const second = loadConversation("sess-b", file, statSync(file).mtimeMs);

    assert.notEqual(first, second);
    assert.ok(second.entryCount > first.entryCount);
  });
});

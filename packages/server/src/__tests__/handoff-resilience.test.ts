import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { UUID } from "@autonomos/core";
import { withPendingHandoffCount } from "../agents/handoffEnrich.js";
import {
  _resetCacheForTesting,
  buildAgent,
  insertAgent,
} from "../agents/store.js";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
} from "../configDir.js";
import { handoffQueueCount } from "../handoffQueue.js";

// A corrupt queue file (truncated / non-JSON) must NOT take down the always-on
// agent list: readQueue stays strict (a queue of user messages is not silently
// treated as empty), but the list-enrichment helper degrades that ONE agent to
// no badge instead of throwing a 500 for the whole fleet (finding 3).

let dir: string;
function queueDir(): string {
  return join(dir, "handoff-queues");
}

function seedGemini(): UUID {
  const id = randomUUID() as UUID;
  insertAgent(
    buildAgent({
      id,
      name: "Gigi",
      workingDirectory: "/tmp",
      provider: "gemini-cli",
      providerSessionId: id,
      permissionMode: "ask",
      status: "running",
    }),
  );
  return id;
}

function writeCorruptQueue(id: string): void {
  mkdirSync(queueDir(), { recursive: true });
  writeFileSync(join(queueDir(), `${id}.json`), "{ this is not: valid json");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "handoff-resilience-"));
  _setConfigDirForTesting(dir);
  _resetCacheForTesting();
});
afterEach(() => {
  _resetConfigDirForTesting();
  _resetCacheForTesting();
  rmSync(dir, { recursive: true, force: true });
});

describe("hand-off queue — corrupt-file resilience", () => {
  it("readQueue/handoffQueueCount THROWS on a corrupt file (never a silent empty)", () => {
    const id = seedGemini();
    writeCorruptQueue(id);
    assert.throws(
      () => handoffQueueCount(id),
      /Failed to load hand-off queue/,
      "a corrupt file must throw, not masquerade as an empty queue",
    );
  });

  it("withPendingHandoffCount degrades a corrupt file to no-badge instead of throwing", () => {
    const id = seedGemini();
    const agent = { id, provider: "gemini-cli" } as never;
    writeCorruptQueue(id);

    // Must NOT throw — one bad file can't 500 the whole agent list.
    const enriched = withPendingHandoffCount(agent);
    assert.equal(
      (enriched as { pendingHandoffCount?: number }).pendingHandoffCount,
      undefined,
      "a corrupt queue yields no badge, not a crash",
    );
  });
});

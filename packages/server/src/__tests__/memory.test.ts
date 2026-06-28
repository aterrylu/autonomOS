import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MemoryEvent } from "@autonomos/core";
import { MEMORY_SUMMARY_MAX } from "@autonomos/core";

// ── Test isolation ────────────────────────────────────────────────
// AUTONOMOS_CONFIG_DIR must be set before importing the memory module
// because configDir captures it at module load time.
const TEST_DIR = join(tmpdir(), `autonomos-memory-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const {
  _resetMemoryForTesting,
  _flushIndexForTesting,
  initMemory,
  queryMemory,
  recordEvent,
} = await import("../memory/events.js");

const {
  getIndexPath,
  getProjectSummaryPath,
  getProjectTimelinePath,
  getSchemaDocPath,
  getEventsFile,
} = await import("../memory/store.js");

function cleanDir(): void {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

beforeEach(() => {
  cleanDir();
  _resetMemoryForTesting();
  initMemory();
});

afterEach(() => {
  _resetMemoryForTesting();
  cleanDir();
});

// ── Round-trip ────────────────────────────────────────────────────

describe("memory — round-trip", () => {
  it("write event → read at L3", () => {
    const written = recordEvent({
      type: "agent_message",
      summary: "hello",
      project: "alpha",
      actor: { agentId: "a1", agentName: "Alice", sessionId: null },
    });
    assert.ok(written, "recordEvent returned null");
    const res = queryMemory({ level: "L3" });
    assert.equal(res.level, "L3");
    if (res.level !== "L3" || !("events" in res)) {
      assert.fail("expected L3 events response");
    }
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].id, written.id);
    assert.equal(res.events[0].summary, "hello");
    assert.equal(res.events[0].project, "alpha");
  });

  it("L3 fetch-by-id returns single event", () => {
    const a = recordEvent({ type: "agent_message", summary: "one" });
    recordEvent({ type: "agent_message", summary: "two" });
    assert.ok(a);
    const res = queryMemory({ level: "L3", id: a.id });
    if (res.level !== "L3" || !("event" in res))
      assert.fail("expected single-event response");
    assert.ok(res.event);
    assert.equal(res.event?.id, a.id);
    assert.equal(res.event?.summary, "one");
  });

  it("L3 fetch-by-id returns null when not found", () => {
    const res = queryMemory({ level: "L3", id: "DEADBEEF-NOPE" });
    if (res.level !== "L3" || !("event" in res))
      assert.fail("expected single-event response");
    assert.equal(res.event, null);
  });
});

// ── Filters ───────────────────────────────────────────────────────

describe("memory — L3 filters", () => {
  it("since/until inclusive/exclusive bounds", () => {
    const base = Date.UTC(2026, 4, 1, 12, 0, 0);
    recordEvent({ type: "agent_message", summary: "early", ts: base });
    recordEvent({ type: "agent_message", summary: "mid", ts: base + 1000 });
    recordEvent({ type: "agent_message", summary: "late", ts: base + 2000 });

    const res = queryMemory({
      level: "L3",
      since: base + 1000,
      until: base + 2000,
    });
    if (res.level !== "L3" || !("events" in res)) assert.fail();
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].summary, "mid");
  });

  it("type filter", () => {
    recordEvent({ type: "agent_message", summary: "msg" });
    recordEvent({ type: "schedule_fired", summary: "fire" });
    recordEvent({ type: "agent_created", summary: "new agent" });

    const res = queryMemory({
      level: "L3",
      type: ["agent_message", "agent_created"],
    });
    if (res.level !== "L3" || !("events" in res)) assert.fail();
    assert.equal(res.events.length, 2);
    const types = res.events.map((e) => e.type).sort();
    assert.deepEqual(types, ["agent_created", "agent_message"]);
  });

  it("actor filter is case-insensitive", () => {
    recordEvent({
      type: "agent_message",
      summary: "from alice",
      actor: { agentName: "Alice", agentId: null, sessionId: null },
    });
    recordEvent({
      type: "agent_message",
      summary: "from bob",
      actor: { agentName: "Bob", agentId: null, sessionId: null },
    });

    const res = queryMemory({ level: "L3", actor: "alice" });
    if (res.level !== "L3" || !("events" in res)) assert.fail();
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].actor.agentName, "Alice");
  });

  it("limit clamped to [1, 1000] and default 100", () => {
    for (let i = 0; i < 5; i++) {
      recordEvent({ type: "agent_message", summary: `m${i}` });
    }
    const res = queryMemory({ level: "L3", limit: 2 });
    if (res.level !== "L3" || !("events" in res)) assert.fail();
    assert.equal(res.events.length, 2);
  });

  it('project filter: "untagged" sentinel matches null-project events', () => {
    recordEvent({
      type: "agent_message",
      summary: "with project",
      project: "x",
    });
    recordEvent({ type: "agent_message", summary: "no project" });

    const tagged = queryMemory({ level: "L3", project: "x" });
    if (tagged.level !== "L3" || !("events" in tagged)) assert.fail();
    assert.equal(tagged.events.length, 1);
    assert.equal(tagged.events[0].project, "x");

    const untagged = queryMemory({ level: "L3", project: "untagged" });
    if (untagged.level !== "L3" || !("events" in untagged)) assert.fail();
    assert.equal(untagged.events.length, 1);
    assert.equal(untagged.events[0].project, null);
  });
});

// ── Project inheritance ───────────────────────────────────────────

describe("memory — project inheritance", () => {
  it("explicit project on event takes precedence over actor", () => {
    recordEvent({
      type: "agent_message",
      summary: "explicit",
      project: "Custom Slug!",
      actor: { agentName: "Alice", agentId: null, sessionId: null },
    });
    const res = queryMemory({ level: "L3" });
    if (res.level !== "L3" || !("events" in res)) assert.fail();
    assert.equal(res.events[0].project, "custom-slug");
  });

  it("project=null is explicit untagged", () => {
    recordEvent({
      type: "agent_message",
      summary: "null project",
      project: null,
    });
    const res = queryMemory({ level: "L3" });
    if (res.level !== "L3" || !("events" in res)) assert.fail();
    assert.equal(res.events[0].project, null);
  });
});

// ── ULID-style ordering ───────────────────────────────────────────

describe("memory — id is sortable", () => {
  it("ids generated later sort lexicographically greater", () => {
    const a = recordEvent({ type: "agent_message", summary: "a", ts: 1000 });
    const b = recordEvent({ type: "agent_message", summary: "b", ts: 2000 });
    const c = recordEvent({
      type: "agent_message",
      summary: "c",
      ts: 3_000_000,
    });
    assert.ok(a && b && c);
    const sorted = [a.id, c.id, b.id].sort();
    assert.deepEqual(sorted, [a.id, b.id, c.id]);
  });
});

// ── Summary truncation ────────────────────────────────────────────

describe("memory — summary truncation", () => {
  it(`caps summary at ${MEMORY_SUMMARY_MAX} chars with "…"`, () => {
    const long = "x".repeat(MEMORY_SUMMARY_MAX + 50);
    const w = recordEvent({ type: "agent_message", summary: long });
    assert.ok(w);
    assert.equal(w.summary.length, MEMORY_SUMMARY_MAX);
    assert.ok(w.summary.endsWith("…"));
  });

  it("short summaries pass through unchanged", () => {
    const w = recordEvent({ type: "agent_message", summary: "short" });
    assert.ok(w);
    assert.equal(w.summary, "short");
  });
});

// ── L0 freshness ──────────────────────────────────────────────────

describe("memory — L0 index", () => {
  it("rewrites index.md on every event with project counts and latest ts", () => {
    // Index rewrites are debounced; flush so the assertion doesn't race the timer.
    recordEvent({ type: "agent_message", summary: "first", project: "p" });
    _flushIndexForTesting();
    let content = readFileSync(getIndexPath(), "utf-8");
    assert.match(content, /\| p \| 1 \|/);

    recordEvent({ type: "agent_message", summary: "second", project: "p" });
    recordEvent({ type: "agent_message", summary: "other", project: "q" });
    _flushIndexForTesting();
    content = readFileSync(getIndexPath(), "utf-8");
    assert.match(content, /\| p \| 2 \|/);
    assert.match(content, /\| q \| 1 \|/);
  });

  it("queryMemory L0 returns the index content + sourcePath", () => {
    recordEvent({ type: "agent_message", summary: "x", project: "p" });
    _flushIndexForTesting();
    const res = queryMemory({}); // default level L0
    assert.equal(res.level, "L0");
    if (res.level !== "L0") assert.fail();
    assert.equal(res.sourcePath, getIndexPath());
    assert.match(res.content, /autonomOS Memory Index/);
    assert.match(res.content, /\| p \|/);
  });
});

// ── L1/L2 skeleton provisioning ──────────────────────────────────

describe("memory — L1/L2 skeletons", () => {
  it("creates summary.md and timeline.md on first event for a slug", () => {
    recordEvent({
      type: "agent_message",
      summary: "init",
      project: "new-proj",
    });
    assert.ok(existsSync(getProjectSummaryPath("new-proj")));
    assert.ok(existsSync(getProjectTimelinePath("new-proj")));
  });

  it("L1 query returns the skeleton content", () => {
    recordEvent({ type: "agent_message", summary: "init", project: "alpha" });
    const res = queryMemory({ level: "L1", project: "alpha" });
    if (res.level !== "L1") assert.fail();
    assert.match(res.content, /# alpha/);
    assert.equal(res.sourcePath, getProjectSummaryPath("alpha"));
  });

  it("L1 query for unknown slug returns empty content (no error)", () => {
    const res = queryMemory({ level: "L1", project: "never-seen" });
    if (res.level !== "L1") assert.fail();
    assert.equal(res.content, "");
  });
});

// ── SCHEMA.md ─────────────────────────────────────────────────────

describe("memory — SCHEMA.md", () => {
  it("written by initMemory", () => {
    assert.ok(existsSync(getSchemaDocPath()));
    const content = readFileSync(getSchemaDocPath(), "utf-8");
    assert.match(content, /Schema version: 1/);
    assert.match(content, /memory_query/);
  });
});

// ── Validation ────────────────────────────────────────────────────

describe("memory — query validation", () => {
  it("L1 without project throws", () => {
    assert.throws(() => queryMemory({ level: "L1" }), /requires `project`/);
  });

  it("L2 with neither project nor date throws", () => {
    assert.throws(
      () => queryMemory({ level: "L2" }),
      /requires `project` or `date`/,
    );
  });

  it("L2 with date returns daily file (empty when not generated)", () => {
    const res = queryMemory({ level: "L2", date: "2026-05-09" });
    if (res.level !== "L2") assert.fail();
    assert.equal(res.content, "");
    assert.match(res.sourcePath, /2026-05-09\.md$/);
  });

  it("L2 with bad date format throws", () => {
    assert.throws(
      () => queryMemory({ level: "L2", date: "may-9-2026" }),
      /YYYY-MM-DD/,
    );
  });
});

// ── Bootstrap from disk ──────────────────────────────────────────

describe("memory — bootstrap", () => {
  it("rebuilds index from on-disk JSONL after restart", () => {
    // Pre-seed events on disk WITHOUT going through recordEvent (simulating
    // a prior server run), then reset module state and reinit.
    const events: Pick<MemoryEvent, "v" | "id" | "ts" | "project" | "summary"> &
      Record<string, unknown> = {
      v: 1,
      id: "0000018F00000000-AAAAAAAAAAAA",
      ts: Date.UTC(2026, 4, 1, 0, 0, 0),
      project: "preexisting",
      summary: "from disk",
    };
    const file = getEventsFile(events.ts);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        ...events,
        actor: { agentId: null, agentName: "system", sessionId: null },
        type: "agent_message",
      })}\n`,
    );

    _resetMemoryForTesting();
    initMemory();
    const res = queryMemory({});
    if (res.level !== "L0") assert.fail();
    assert.match(res.content, /\| preexisting \| 1 \|/);
  });
});

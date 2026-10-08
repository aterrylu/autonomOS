/**
 * GET /api/projects shares one scan between concurrent requests and reuses a
 * successful result briefly. Each open dashboard tab polls it every 30s on its
 * own phase, and each request ran the full scan (~35-50ms of event-loop work
 * on a real history, ~3x on a loaded box), so N tabs cost N scans.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { Hono } from "hono";

// Isolation before the route loads: no real agent store or session history.
process.env.AUTONOMOS_CONFIG_DIR = join(tmpdir(), `aos-pcache-${randomUUID()}`);
process.env.CODEX_HOME = join(tmpdir(), `aos-pcache-codex-${randomUUID()}`);
process.env.GEMINI_CLI_HOME = join(tmpdir(), `aos-pcache-gem-${randomUUID()}`);
process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `aos-pcache-cc-${randomUUID()}`);

const { projectRouter, _setDepsForTesting, _resetForTesting } = await import(
  "../routes/projects.js"
);
const app = new Hono().route("/api/projects", projectRouter);

const session = (id: string): SDKSessionInfo =>
  ({
    sessionId: id,
    cwd: "/Users/t/work/p",
    summary: `session ${id}`,
    lastModified: 1_700_000_000_000,
    fileSize: 1,
  }) as SDKSessionInfo;

/** Stub every scan; `list` decides what the SDK listing does. */
function stub(list: () => Promise<SDKSessionInfo[]>, cacheMs = 5_000) {
  _setDepsForTesting({
    listSessions: list as never,
    batchGetTitles: async () => new Map(),
    listCodexSessions: async () => [],
    listGeminiSessions: async () => [],
    readClaudeSessionMeta: async () => new Map(),
    cacheMs,
  });
}

const get = async () => {
  const r = await app.request("/api/projects");
  return { status: r.status, body: (await r.json()) as unknown };
};

afterEach(() => _resetForTesting());

describe("GET /api/projects: shared scan", () => {
  it("concurrent requests share ONE scan", async () => {
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    stub(async () => {
      scans++;
      await gate; // hold the scan open while the other requests arrive
      return [session("a")];
    });
    const pending = [get(), get(), get()];
    await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all(pending);
    assert.equal(scans, 1);
    for (const r of results) assert.equal(r.status, 200);
    assert.deepEqual(results[1].body, results[0].body);
  });

  it("a successful result is reused within the TTL", async () => {
    let scans = 0;
    stub(async () => {
      scans++;
      return [session("a")];
    });
    await get();
    await get();
    assert.equal(scans, 1);
  });

  it("past the TTL, the next request scans again", async () => {
    let scans = 0;
    stub(async () => {
      scans++;
      return [session(`s${scans}`)];
    }, 1);
    await get();
    await new Promise((r) => setTimeout(r, 10)); // well past the 1ms TTL
    await get();
    assert.equal(scans, 2);
  });

  it("a failed scan is never cached: the next request retries", async () => {
    let scans = 0;
    stub(async () => {
      scans++;
      if (scans === 1) throw new Error("transient");
      return [session("a")];
    });
    assert.equal((await get()).status, 500);
    assert.equal((await get()).status, 200);
    assert.equal(scans, 2);
  });
});

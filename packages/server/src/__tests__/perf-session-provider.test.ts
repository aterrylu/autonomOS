import assert from "node:assert/strict";
import { mkdtempSync as __mkdtemp, existsSync, readFileSync } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
import { describe, it } from "node:test";

process.env.AUTONOMOS_CONFIG_DIR = __mkdtemp(__join(__tmpdir(), "aos-perf-"));

const { perfRouter } = await import("../routes/perf.js");
const { getAgent } = await import("../agents/store.js");
const { verifyAgentToken } = await import("../agentCredentials.js");

/**
 * L1: perf-mode synthetic sessions (dev/perf only). The README hero script
 * (#551) uses them for a scripted Codex pane and a Gemini org-chart node, so
 * it needs no real CLI and no login: the session must claim the right
 * provider, and its status must be poseable through ordinary hook ingest.
 */

async function create(body: Record<string, unknown>) {
  const res = await perfRouter.request("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("POST /api/perf/session provider", () => {
  it("defaults to claude-code (unchanged for the perf harness)", async () => {
    const r = await create({
      id: "00000000-0000-4000-8000-0000000000a1",
      name: "p",
    });
    assert.equal(r.status, 200);
    assert.equal(
      getAgent("00000000-0000-4000-8000-0000000000a1")?.provider,
      "claude-code",
    );
  });

  it("registers a codex or gemini-cli session when asked", async () => {
    for (const [id, provider] of [
      ["00000000-0000-4000-8000-0000000000a2", "codex"],
      ["00000000-0000-4000-8000-0000000000a3", "gemini-cli"],
    ] as const) {
      const r = await create({ id, name: provider, provider });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(getAgent(id)?.provider, provider);
    }
  });

  it("refuses an unknown provider", async () => {
    const r = await create({
      id: "00000000-0000-4000-8000-0000000000a4",
      provider: "nope",
    });
    assert.equal(r.status, 400);
  });

  it("writes the session's agent token file, so its status can be posed via hook ingest", async () => {
    const id = "00000000-0000-4000-8000-0000000000a5";
    await create({ id, name: "g", provider: "gemini-cli" });
    const file = __join(
      process.env.AUTONOMOS_CONFIG_DIR as string,
      "agent-tokens",
      id,
    );
    assert.ok(existsSync(file));
    assert.equal(verifyAgentToken(id, readFileSync(file, "utf8").trim()), true);
  });
});

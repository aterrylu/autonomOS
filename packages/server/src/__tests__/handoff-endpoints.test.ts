import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

// Config dir isolated before importing the router (routes read it transitively
// at import). #350: an isolated (non-default) dir is allowed under the test guard.
const DIR = mkdtempSync(join(tmpdir(), "autonomos-handoff-ep-"));
process.env.AUTONOMOS_CONFIG_DIR = DIR;

const { agentsRouter } = await import("../routes/agents.js");
const { buildAgent, insertAgent, _resetCacheForTesting } = await import(
  "../agents/store.js"
);
const { enqueueHandoff, listHandoffQueue } = await import("../handoffQueue.js");

const app = new Hono();
app.route("/api/agents", agentsRouter);

function seedGemini(): string {
  const id = randomUUID();
  insertAgent(
    buildAgent({
      id: id as never,
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

beforeEach(() => _resetCacheForTesting());
after(() => rmSync(DIR, { recursive: true, force: true }));

describe("hand-off queue REST endpoints", () => {
  it("GET /:id/queue lists items; DELETE /:id/queue discards all", async () => {
    const id = seedGemini();
    enqueueHandoff(id, { from: "a", message: "one" });
    enqueueHandoff(id, { from: "b", message: "two" });

    const list = await app.request(`/api/agents/${id}/queue`);
    assert.equal(list.status, 200);
    const listed = (await list.json()) as { items: unknown[] };
    assert.equal(listed.items.length, 2);

    const del = await app.request(`/api/agents/${id}/queue`, {
      method: "DELETE",
    });
    assert.equal(del.status, 200);
    const body = (await del.json()) as { cleared: number };
    assert.equal(body.cleared, 2);
    assert.equal(listHandoffQueue(id).length, 0);
  });

  it("DELETE /:id/queue/:itemId discards one; 404 for an unknown item", async () => {
    const id = seedGemini();
    const r = enqueueHandoff(id, { from: "a", message: "x" });
    assert.ok(r.ok);
    if (!r.ok) return;

    const bad = await app.request(`/api/agents/${id}/queue/nope`, {
      method: "DELETE",
    });
    assert.equal(bad.status, 404);

    const ok = await app.request(`/api/agents/${id}/queue/${r.item.id}`, {
      method: "DELETE",
    });
    assert.equal(ok.status, 200);
    assert.equal(listHandoffQueue(id).length, 0);
  });

  it("404s for an unknown agent", async () => {
    const res = await app.request(`/api/agents/${randomUUID()}/queue`);
    assert.equal(res.status, 404);
  });

  it("GET /api/agents enriches a manual-queue agent with pendingHandoffCount (badge on load)", async () => {
    // The dashboard badge needs the count on the INITIAL snapshot, not only via
    // a later delta. This pins the REST boundary; the /ws/agents reconcile uses
    // the same shared withPendingHandoffCount enricher (live-QA caught the WS
    // path missing it).
    const withQ = seedGemini();
    enqueueHandoff(withQ, { from: "a", message: "one" });
    enqueueHandoff(withQ, { from: "a", message: "two" });
    const withoutQ = seedGemini();

    const res = await app.request("/api/agents");
    const agents = (await res.json()) as Array<{
      id: string;
      pendingHandoffCount?: number;
    }>;
    assert.equal(
      agents.find((a) => a.id === withQ)?.pendingHandoffCount,
      2,
      "a manual-queue agent with a queue carries the count",
    );
    assert.equal(
      agents.find((a) => a.id === withoutQ)?.pendingHandoffCount,
      undefined,
      "an empty queue adds no count",
    );
  });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * PATCH /api/agents/:id — rename (the right-click Rename feature). Re-adds the
 * once-removed PATCH route on the body-`version` optimistic-concurrency
 * convention. These pin: a successful rename bumps the record; an empty/blank
 * name is rejected; a name already held by another RUNNING agent is a 409
 * (namesake guard) so the collision surfaces here, not later at the restart's
 * attach; and a stale `version` is a 409.
 */
const DIR = join(tmpdir(), `autonomos-rename-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = DIR;

let app: Hono;
let aId: string;
let bId: string;

async function renameReq(id: string, body: unknown) {
  const res = await app.request(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("PATCH /api/agents/:id — rename", () => {
  before(async () => {
    const store = await import("../agents/store.js");
    const mk = (name: string) =>
      store.insertAgent(
        store.buildAgent({
          id: randomUUID(),
          name,
          workingDirectory: "/tmp",
          provider: "claude-code",
          providerSessionId: randomUUID(),
          permissionMode: "ask",
        }),
      );
    aId = mk("rename-a").id; // buildAgent defaults status: "running"
    bId = mk("rename-b").id;
    const { agentsRouter } = await import("../routes/agents.js");
    app = new Hono();
    app.route("/api/agents", agentsRouter);
  });
  after(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(DIR, { recursive: true, force: true });
  });

  it("renames the record and bumps its version", async () => {
    const store = await import("../agents/store.js");
    const before = store.getAgent(aId)?.version ?? 0;
    const res = await renameReq(aId, { name: "rename-a-new" });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(store.getAgent(aId)?.name, "rename-a-new");
    assert.equal(store.getAgent(aId)?.version, before + 1);
  });

  it("trims the name", async () => {
    const store = await import("../agents/store.js");
    const res = await renameReq(aId, { name: "  spaced  " });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(store.getAgent(aId)?.name, "spaced");
  });

  it("rejects an empty name (zod) and a whitespace-only name (route trim)", async () => {
    const empty = await renameReq(aId, { name: "" });
    assert.equal(empty.status, 400, JSON.stringify(empty.json));
    const blank = await renameReq(aId, { name: "   " });
    assert.equal(blank.status, 400, JSON.stringify(blank.json));
  });

  it("409s a name already held by another RUNNING agent (namesake guard)", async () => {
    const res = await renameReq(aId, { name: "rename-b" });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json.error), /already running/i);
    // The rename did NOT land — the record keeps its previous name.
    const store = await import("../agents/store.js");
    assert.equal(store.getAgent(aId)?.name, "spaced");
  });

  it("409s a stale version", async () => {
    const store = await import("../agents/store.js");
    const current = store.getAgent(aId)?.version ?? 1;
    const res = await renameReq(aId, {
      name: "rename-a-v2",
      version: current + 5,
    });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.match(String(res.json.error), /version mismatch/i);
  });

  it("404s an unknown id", async () => {
    const res = await renameReq(randomUUID(), { name: "ghost" });
    assert.equal(res.status, 404, JSON.stringify(res.json));
  });
});

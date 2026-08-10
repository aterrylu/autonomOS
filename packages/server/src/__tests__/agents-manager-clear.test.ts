import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * POST /api/agents/:id/manager — the CLEAR path (consolidation PR B).
 *
 * The channel server's set_manager forwards `{ manager: null }` for the
 * documented remove-manager flow. The zod migration briefly rejected that
 * (`z.string().optional()` refuses null) — every clear from the agent surface
 * became a 400 while the direct-HTTP `{}` and `{managerId: null}` spellings
 * kept working. `nullish()` restored it; these tests pin all three clear
 * spellings so a future schema tightening can't silently break one surface.
 */
const DIR = join(tmpdir(), `autonomos-mgr-clear-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = DIR;

let app: Hono;
let leadId: string;
let workerId: string;

async function setManagerReq(id: string, body: unknown) {
  const res = await app.request(`/api/agents/${id}/manager`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("POST /api/agents/:id/manager — clear spellings", () => {
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
    leadId = mk("clear-lead").id;
    workerId = mk("clear-worker").id;
    const { agentsRouter } = await import("../routes/agents.js");
    app = new Hono();
    app.route("/api/agents", agentsRouter);
  });
  after(async () => {
    const { rmSync } = await import("node:fs");
    rmSync(DIR, { recursive: true, force: true });
  });

  it("sets by name, then `{manager: null}` (the channel set_manager clear) clears it", async () => {
    const set = await setManagerReq(workerId, { manager: "clear-lead" });
    assert.equal(set.status, 200, JSON.stringify(set.json));

    const clear = await setManagerReq(workerId, { manager: null });
    assert.equal(clear.status, 200, JSON.stringify(clear.json));
    const store = await import("../agents/store.js");
    assert.equal(store.getAgent(workerId)?.managerId, null);
  });

  it("`{}` clears", async () => {
    await setManagerReq(workerId, { manager: "clear-lead" });
    const clear = await setManagerReq(workerId, {});
    assert.equal(clear.status, 200, JSON.stringify(clear.json));
    const store = await import("../agents/store.js");
    assert.equal(store.getAgent(workerId)?.managerId, null);
  });

  it("`{managerId: null}` clears", async () => {
    await setManagerReq(workerId, { manager: "clear-lead" });
    const clear = await setManagerReq(workerId, { managerId: null });
    assert.equal(clear.status, 200, JSON.stringify(clear.json));
    const store = await import("../agents/store.js");
    assert.equal(store.getAgent(workerId)?.managerId, null);
  });
});

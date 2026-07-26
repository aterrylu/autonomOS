import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * Write-path reporting for the deprecated `capabilities` field (ADR-058).
 *
 * This is the most novel behaviour in the deprecation and the one most likely
 * to be deleted by a future cleanup: a reviewer sees a `capabilities` key on a
 * schema for a "removed" field and drops it as dead — and the silent-accept
 * defect the ADR set out to kill returns with the suite still green. These
 * assertions lock it: a create request carrying `capabilities` must still
 * succeed AND report that the field was ignored, never accept it in silence.
 *
 * Config dir is set before importing the router (it reads CONFIG_DIR at import).
 * Dynamic import inside before() keeps fs/env side effects off module load.
 */
const TEST_DIR = join(tmpdir(), `autonomos-tmpl-api-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

let app: Hono;

async function post(body: unknown) {
  const res = await app.request("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

const base = {
  name: "worker",
  role: "Worker",
  description: "does the work",
  systemPrompt: "You are a worker.",
};

describe("POST /api/templates — deprecated capabilities reporting (ADR-058)", () => {
  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { templateRouter } = await import("../routes/templates.js");
    app = new Hono();
    app.route("/api/templates", templateRouter);
  });
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("accepts a body with capabilities but reports it was ignored", async () => {
    // The pre-ADR schema is still in every running agent's context, so this is
    // the exact request an upgraded fleet keeps sending.
    const { status, json } = await post({
      ...base,
      name: "legacy-caller",
      capabilities: ["send", "list_agents"],
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true, "the template is still created");
    assert.ok(Array.isArray(json.warnings), "a warnings array is returned");
    assert.ok(
      (json.warnings as string[]).some((w) => /capabilities/i.test(w)),
      "the warning names the ignored field — never a silent accept",
    );
  });

  it("omits warnings entirely for a clean request", async () => {
    const { status, json } = await post({ ...base, name: "clean" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(
      !("warnings" in json),
      "no warnings key when nothing was ignored — the array is signal, not noise",
    );
  });

  it("also reports an invalid permissionMode rather than swallowing it", async () => {
    const { json } = await post({
      ...base,
      name: "bad-mode",
      permissionMode: "autonomous",
    });
    assert.ok(Array.isArray(json.warnings));
    assert.ok(
      (json.warnings as string[]).some((w) => /permissionMode/i.test(w)),
      "an ignored mode is surfaced to the caller, not just the log",
    );
  });

  it("keeps a DEPRECATED capabilities marker on the channel create_template schema", async () => {
    // The channel MCP schema declares `capabilities` ONLY so the field can be
    // reported rather than silently dropped by zod. It reads like dead code —
    // a key for a removed feature — so guard it explicitly: deleting it
    // reinstates the silent accept this ADR removed. Its twin lives on the HTTP
    // MCP zod schema in mcp.ts (harder to introspect); the shared reasoning is
    // documented on both.
    const { TOOL_CREATE_TEMPLATE } = await import("../mcp/tools.js");
    const cap = TOOL_CREATE_TEMPLATE.inputSchema.properties.capabilities as
      | { description?: string }
      | undefined;
    assert.ok(cap, "the reporting marker is still present");
    assert.match(
      String(cap.description),
      /deprecated/i,
      "and is unambiguously labelled so it is not mistaken for a live option",
    );
    assert.ok(
      !TOOL_CREATE_TEMPLATE.inputSchema.required?.includes("capabilities"),
      "never required — it is accepted-and-ignored, not requested",
    );
  });
});

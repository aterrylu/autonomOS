import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * `POST /api/agents` resolves the requested template up front. getTemplate()
 * returns null for a missing file but THROWS for a corrupt one (bad JSON, wrong
 * shape) — the message names the file. That call was moved inside a try in
 * ADR-058's hardening: unwrapped, the throw fell through to the router's
 * onError as a 500, misclassifying an operator config error as a server fault
 * and disagreeing with the MCP create_agent path, which caught it and returned
 * the message. These tests pin the 400 classification and the surviving
 * message. They exercise only the template-resolution branch, which returns
 * before spawnAgent — no PTY is started.
 *
 * Config dir is set before importing the router (routes read it transitively at
 * import); dynamic import inside before() keeps that side effect off module load.
 */
const DIR = join(tmpdir(), `autonomos-agents-tmpl-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = DIR;

let app: Hono;

async function spawn(body: unknown) {
  const res = await app.request("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("POST /api/agents — template resolution errors (ADR-058)", () => {
  before(async () => {
    mkdirSync(join(DIR, "templates"), { recursive: true });
    // A list-wrapped write — the shape a jq/merge pipeline or a fat-fingered
    // edit produces. Pre-hardening this loaded as a truthy "valid" template and
    // spawned a role-less agent; now getTemplate() throws.
    writeFileSync(
      join(DIR, "templates", "wrapped.json"),
      '[{"role":"W","systemPrompt":"x"}]',
    );
    const { agentsRouter } = await import("../routes/agents.js");
    app = new Hono();
    app.route("/api/agents", agentsRouter);
  });
  after(() => rmSync(DIR, { recursive: true, force: true }));

  it("maps a corrupt template to 400, not 500, and keeps the file-naming message", async () => {
    const { status, json } = await spawn({
      workingDirectory: "/tmp",
      template: "wrapped",
      provider: "claude-code",
    });
    assert.equal(status, 400, "operator config error, not a server fault");
    assert.match(
      String(json.error),
      /wrapped\.json/,
      "the message that names the file survives to the REST caller",
    );
  });

  it("still returns 400 not-found for a template that does not exist", async () => {
    const { status, json } = await spawn({
      workingDirectory: "/tmp",
      template: "does-not-exist",
      provider: "claude-code",
    });
    assert.equal(status, 400);
    assert.match(String(json.error), /not found/);
  });
});

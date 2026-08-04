import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * HTTP-status classification for the env-presets route. The storage-layer test
 * (env-presets.test.ts) asserts these paths THROW; this asserts the route maps
 * each throw to the right STATUS. A live QA caught a `Blocked` (code-injection)
 * rejection returning 500 instead of 400 because the unit tests couldn't see
 * the HTTP status — this file is the regression net for that class.
 *
 * Config dir set before importing the router (it reads CONFIG_DIR at import).
 */
const TEST_DIR = join(tmpdir(), `autonomos-preset-api-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

let app: Hono;

async function req(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/env-presets${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("env-presets route — status classification + masking", () => {
  before(async () => {
    mkdirSync(join(TEST_DIR, "env-presets"), { recursive: true });
    const { envPresetRouter } = await import("../routes/env-presets.js");
    app = new Hono();
    app.route("/api/env-presets", envPresetRouter);
  });
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("POST valid → 201", async () => {
    const { status } = await req("POST", "", {
      name: "kimi",
      env: { ANTHROPIC_MODEL: "kimi-k2.7-code" },
      secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
    });
    assert.equal(status, 201);
  });

  it("POST duplicate → 400", async () => {
    const { status } = await req("POST", "", { name: "kimi" });
    assert.equal(status, 400);
  });

  it("POST reserved key → 400", async () => {
    const { status } = await req("POST", "", {
      name: "r",
      env: { PATH: "/evil" },
    });
    assert.equal(status, 400);
  });

  it("POST code-injection key → 400 (was 500 — the QA-caught bug)", async () => {
    const { status, json } = await req("POST", "", {
      name: "evil",
      env: { LD_PRELOAD: "/evil.so" },
    });
    assert.equal(status, 400, `expected 400, got ${status}: ${json?.error}`);
  });

  it("PUT code-injection key → 400", async () => {
    const { status } = await req("PUT", "/kimi", {
      env: { NODE_OPTIONS: "--require /evil.js" },
    });
    assert.equal(status, 400);
  });

  it("PUT missing preset → 404", async () => {
    const { status } = await req("PUT", "/nope", { label: "x" });
    assert.equal(status, 404);
  });

  it("GET → secret masked, never plaintext", async () => {
    await req("PUT", "/kimi", {
      secrets: { ANTHROPIC_AUTH_TOKEN: "sk-live-secret-7777" },
    });
    const { status, json } = await req("GET", "/kimi");
    assert.equal(status, 200);
    const secrets = (json as { secrets: Record<string, string> }).secrets;
    assert.equal(secrets.ANTHROPIC_AUTH_TOKEN, "••••7777");
    assert.ok(
      !JSON.stringify(json).includes("sk-live-secret-7777"),
      "the plaintext secret must never appear in a GET response",
    );
  });

  it("DELETE missing → 404", async () => {
    const { status } = await req("DELETE", "/nope");
    assert.equal(status, 404);
  });
});

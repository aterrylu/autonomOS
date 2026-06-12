import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { Hono } from "hono";
import {
  _resetConfigDirForTesting,
  _setConfigDirForTesting,
  ensureConfigDir,
} from "../configDir.js";
import { channelsRouter } from "../routes/channels.js";
import { settingsRouter } from "../routes/settings.js";

/**
 * API-level coverage for:
 *   GET /api/channels/status  — reports the known server:* channels
 *   PUT /api/settings (channels) — rejects malformed channel ids,
 *     including stale plugin:* ids from before plugin channels were removed
 */

let tmpDir: string;

function createApp(): Hono {
  const app = new Hono();
  app.route("/api/channels", channelsRouter);
  app.route("/api/settings", settingsRouter);
  return app;
}

function seedSettings(data: Record<string, unknown>): void {
  ensureConfigDir();
  writeFileSync(
    join(tmpDir, "settings.json"),
    `${JSON.stringify(data, null, 2)}\n`,
    { mode: 0o600 },
  );
}

describe("GET /api/channels/status", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-channels-api-"));
    _setConfigDirForTesting(tmpDir);
  });

  after(() => {
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports server:autonomos as ok with no fix command", async () => {
    const res = await createApp().request("/api/channels/status");
    assert.equal(res.status, 200);
    const { channels } = (await res.json()) as {
      channels: Array<{ id: string; status: string; fix: string | null }>;
    };
    assert.equal(channels.length, 1);
    assert.equal(channels[0].id, "server:autonomos");
    assert.equal(channels[0].status, "ok");
    assert.equal(channels[0].fix, null);
  });
});

describe("PUT /api/settings — channel validation", () => {
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autonomos-channels-settings-"));
    _setConfigDirForTesting(tmpDir);
    seedSettings({});
  });

  after(() => {
    _resetConfigDirForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    seedSettings({});
  });

  async function put(body: unknown) {
    const res = await createApp().request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json };
  }

  it("rejects malformed channel identifiers (400)", async () => {
    const { status, json } = await put({ channels: ["totally-malformed"] });
    assert.equal(status, 400);
    assert.match(String(json.error), /Invalid channel identifier/);
    assert.match(String(json.error), /totally-malformed/);
  });

  it("rejects plugin:* channels — removed feature (400)", async () => {
    const { status, json } = await put({
      channels: ["plugin:telegram@claude-plugins-official"],
    });
    assert.equal(status, 400);
    assert.match(String(json.error), /Invalid channel identifier/);
  });

  it("accepts server:autonomos", async () => {
    const { status, json } = await put({ channels: ["server:autonomos"] });
    assert.equal(status, 200);
    assert.deepEqual(json.channels, ["server:autonomos"]);
  });

  it("accepts empty array (explicit no-channels)", async () => {
    const { status, json } = await put({ channels: [] });
    assert.equal(status, 200);
    assert.deepEqual(json.channels, []);
  });

  it("ignores inboxAgent in the request body — removed feature", async () => {
    // Older dashboards may still send it; it must be accepted-and-discarded,
    // never persisted or echoed back.
    const { status, json } = await put({ inboxAgent: "Dispatcher" });
    assert.equal(status, 200);
    assert.equal("inboxAgent" in json, false);
  });

  it("ignores anthropic override keys in the request body — removed feature", async () => {
    const { status, json } = await put({
      anthropicBaseUrl: "http://litellm:4000",
      anthropicAuthToken: "sk-stale",
      anthropicOverrideEnabled: true,
    });
    assert.equal(status, 200);
    assert.equal("anthropicBaseUrl" in json, false);
    assert.equal("anthropicAuthToken" in json, false);
    assert.equal("anthropicOverrideEnabled" in json, false);
    // Nothing reached disk: GET must not surface them either.
    const res = await createApp().request("/api/settings");
    const fresh = (await res.json()) as Record<string, unknown>;
    assert.equal("anthropicBaseUrl" in fresh, false);
    assert.equal("anthropicAuthToken" in fresh, false);
  });
});

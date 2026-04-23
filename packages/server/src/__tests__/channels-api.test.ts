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
import {
  _setInstalledPluginsForTesting,
  channelsRouter,
} from "../routes/channels.js";
import { settingsRouter } from "../routes/settings.js";

/**
 * API-level coverage for:
 *   GET /api/channels/status  — reports installed/enabled/disabled per-channel
 *   PUT /api/settings (channels) — rejects malformed and broken channel ids
 *
 * Uses the test-only plugin injector so we never spawn `claude plugin list`.
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
    _setInstalledPluginsForTesting(undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    _setInstalledPluginsForTesting(undefined);
  });

  it("reports ok for installed+enabled plugins and server: channels", async () => {
    _setInstalledPluginsForTesting([
      { id: "telegram@claude-plugins-official", enabled: true },
      { id: "discord@claude-plugins-official", enabled: true },
    ]);
    const res = await createApp().request("/api/channels/status");
    assert.equal(res.status, 200);
    const { channels } = (await res.json()) as {
      channels: Array<{ id: string; status: string; fix: string | null }>;
    };
    const byId = Object.fromEntries(channels.map((c) => [c.id, c]));
    assert.equal(byId["server:autonomos"].status, "ok");
    assert.equal(byId["plugin:telegram@claude-plugins-official"].status, "ok");
    assert.equal(byId["plugin:discord@claude-plugins-official"].status, "ok");
    assert.equal(byId["plugin:telegram@claude-plugins-official"].fix, null);
  });

  it("reports not-installed with a fix command for missing plugins", async () => {
    _setInstalledPluginsForTesting([
      { id: "telegram@claude-plugins-official", enabled: true },
    ]);
    const res = await createApp().request("/api/channels/status");
    const { channels } = (await res.json()) as {
      channels: Array<{ id: string; status: string; fix: string | null }>;
    };
    const discord = channels.find(
      (c) => c.id === "plugin:discord@claude-plugins-official",
    );
    assert.equal(discord?.status, "not-installed");
    assert.equal(
      discord?.fix,
      "claude plugin install discord@claude-plugins-official",
    );
  });

  it("reports disabled with an enable command for disabled plugins", async () => {
    _setInstalledPluginsForTesting([
      { id: "telegram@claude-plugins-official", enabled: false },
      { id: "discord@claude-plugins-official", enabled: true },
    ]);
    const res = await createApp().request("/api/channels/status");
    const { channels } = (await res.json()) as {
      channels: Array<{ id: string; status: string; fix: string | null }>;
    };
    const tg = channels.find(
      (c) => c.id === "plugin:telegram@claude-plugins-official",
    );
    assert.equal(tg?.status, "disabled");
    assert.equal(
      tg?.fix,
      "claude plugin enable telegram@claude-plugins-official",
    );
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
    _setInstalledPluginsForTesting(undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    _setInstalledPluginsForTesting(undefined);
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
    _setInstalledPluginsForTesting([]);
    const { status, json } = await put({ channels: ["totally-malformed"] });
    assert.equal(status, 400);
    assert.match(String(json.error), /Invalid channel identifier/);
    assert.match(String(json.error), /totally-malformed/);
  });

  it("rejects not-installed plugins with an actionable message (400)", async () => {
    _setInstalledPluginsForTesting([]);
    const { status, json } = await put({
      channels: ["plugin:telegram@claude-plugins-official"],
    });
    assert.equal(status, 400);
    assert.match(String(json.error), /silently no-op/);
    assert.match(String(json.error), /not-installed/);
  });

  it("rejects disabled plugins (400)", async () => {
    _setInstalledPluginsForTesting([
      { id: "telegram@claude-plugins-official", enabled: false },
    ]);
    const { status, json } = await put({
      channels: ["plugin:telegram@claude-plugins-official"],
    });
    assert.equal(status, 400);
    assert.match(String(json.error), /disabled/);
  });

  it("accepts server:autonomos regardless of plugin detection", async () => {
    // server: channels never appear in `claude plugin list` output.
    _setInstalledPluginsForTesting([]);
    const { status, json } = await put({ channels: ["server:autonomos"] });
    assert.equal(status, 200);
    assert.deepEqual(json.channels, ["server:autonomos"]);
  });

  it("accepts mixed installed plugins + server:autonomos", async () => {
    _setInstalledPluginsForTesting([
      { id: "telegram@claude-plugins-official", enabled: true },
      { id: "discord@claude-plugins-official", enabled: true },
    ]);
    const { status, json } = await put({
      channels: [
        "server:autonomos",
        "plugin:telegram@claude-plugins-official",
        "plugin:discord@claude-plugins-official",
      ],
    });
    assert.equal(status, 200);
    assert.deepEqual(json.channels, [
      "server:autonomos",
      "plugin:telegram@claude-plugins-official",
      "plugin:discord@claude-plugins-official",
    ]);
  });

  it("accepts empty array (explicit no-channels)", async () => {
    _setInstalledPluginsForTesting([]);
    const { status, json } = await put({ channels: [] });
    assert.equal(status, 200);
    assert.deepEqual(json.channels, []);
  });

  it("fail-opens on detection failure — plugin saves succeed when unknown", async () => {
    // null simulates `claude plugin list --json` failing. The guard
    // must not mistake "detection failed" for "plugin not installed".
    _setInstalledPluginsForTesting(null);
    const { status, json } = await put({
      channels: ["server:autonomos", "plugin:telegram@claude-plugins-official"],
    });
    assert.equal(status, 200);
    assert.deepEqual(json.channels, [
      "server:autonomos",
      "plugin:telegram@claude-plugins-official",
    ]);
  });
});

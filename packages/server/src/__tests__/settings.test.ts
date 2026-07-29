import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// Set AUTONOMOS_CONFIG_DIR before importing settings (reads CONFIG_DIR at load time)
const TEST_DIR = join(tmpdir(), `autonomos-test-settings-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { getSettings, updateSettings } = await import("../settings.js");

const SETTINGS_FILE = join(TEST_DIR, "settings.json");

describe("getSettings", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns default channels when no settings file exists", () => {
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("returns default channels when file has no channels key", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ autoTrust: false }));
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("returns default channels when channels is null in JSON", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channels: null }));
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("preserves explicit empty array (user disabled all channels)", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channels: [] }));
    const settings = getSettings();
    assert.deepEqual(settings.channels, []);
  });

  it("preserves custom channels", () => {
    const custom = ["server:autonomos", "server:custom"];
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channels: custom }));
    const settings = getSettings();
    assert.deepEqual(settings.channels, custom);
  });

  it("drops stale plugin:* channels from removed integrations", () => {
    // Old settings.json files may still list the removed Telegram/Discord
    // plugin channels — the sanitizer discards them on read.
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        channels: [
          "server:autonomos",
          "plugin:telegram@claude-plugins-official",
          "plugin:discord@claude-plugins-official",
        ],
      }),
    );
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("scrubs removed keys (inboxAgent, and the whole gateway block) on read", () => {
    // `gateway` used to be partially scrubbed — telegram/discord dropped, slack
    // KEPT, because the slack adapter still had a connect-loop reading it. That
    // loop went with the adapters in ADR-064, so the entire key is now dead and
    // is scrubbed whole. A surviving `gateway.slack.enabled` would be a setting
    // a user can toggle that does nothing at all.
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        inboxAgent: "Dispatcher",
        gateway: {
          telegram: { enabled: true },
          discord: { enabled: false },
          slack: { enabled: true },
        },
      }),
    );
    const settings = getSettings();
    assert.equal("inboxAgent" in settings, false);
    assert.equal(
      "gateway" in settings,
      false,
      "the whole gateway block is dead, not just its removed platforms",
    );
  });

  it("scrubs removed anthropic override keys on read", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        anthropicBaseUrl: "http://litellm:4000",
        anthropicAuthToken: "sk-secret",
        anthropicOverrideEnabled: true,
        autoTrust: false,
      }),
    );
    const settings = getSettings() as Record<string, unknown>;
    assert.equal("anthropicBaseUrl" in settings, false);
    assert.equal("anthropicAuthToken" in settings, false);
    assert.equal("anthropicOverrideEnabled" in settings, false);
    assert.equal(settings.autoTrust, false);
  });

  it("drops the stale auth token credential from disk on the next persist", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ anthropicAuthToken: "sk-secret" }),
    );
    // Any persist drops the scrubbed key — autoTrust is a neutral trigger.
    updateSettings({ autoTrust: false });
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    assert.equal("anthropicAuthToken" in raw, false);
  });

  it("removes gateway entirely when scrubbing empties it", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        gateway: { telegram: { enabled: true }, discord: { enabled: false } },
      }),
    );
    const settings = getSettings();
    assert.equal("gateway" in settings, false);
  });

  it("drops the whole routes table, including slack routes", () => {
    // Previously this filtered per-platform and KEPT slack routes, because
    // `setRoutes` still fed them to the router's inbound table. ADR-064 deleted
    // setRoutes along with the adapters, so no route of any platform has a
    // reader — a retained slack route would be a rule that silently never fires.
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({
        routes: [
          { id: "r1", platform: "discord", chatId: "g:c", sessionId: "s1" },
          { id: "r2", platform: "telegram", chatId: "123", sessionId: "s2" },
          { id: "r3", platform: "slack", chatId: "w:c", sessionId: "s3" },
        ],
      }),
    );
    const settings = getSettings();
    assert.equal(
      "routes" in settings,
      false,
      "no route has a reader any more — keeping the slack one would be a rule that never fires",
    );
  });

  it("drops scrubbed keys from disk on the next persist", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ inboxAgent: "Dispatcher", autoTrust: false }),
    );
    updateSettings({ autoTrust: false });
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    assert.equal("inboxAgent" in raw, false);
    assert.equal(raw.autoTrust, false);
  });

  it("returns default channels when channels is a string (not array)", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ channels: "server:autonomos" }),
    );
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("deduplicates channels in settings file", () => {
    const duped = [
      "server:autonomos",
      "server:autonomos",
      "server:custom",
      "server:autonomos",
    ];
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channels: duped }));
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos", "server:custom"]);
  });

  it("returns empty settings with defaults for invalid JSON", () => {
    writeFileSync(SETTINGS_FILE, "not json at all");
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("returns empty settings with defaults for JSON array", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify([1, 2, 3]));
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("returns empty settings with defaults for JSON string", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify("hello"));
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("reads other settings alongside default channels", () => {
    writeFileSync(SETTINGS_FILE, JSON.stringify({ autoTrust: false }));
    const settings = getSettings();
    assert.equal(settings.autoTrust, false);
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("scrubs the stale terminalRenderer key on read (renderer removed)", () => {
    // xterm.js is the only renderer now; an old settings.json may still
    // carry the selector — it is accept-and-discarded like other dead keys.
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ autoTrust: false, terminalRenderer: "ghostty-web" }),
    );
    const settings = getSettings() as Record<string, unknown>;
    assert.equal("terminalRenderer" in settings, false);
    assert.equal(settings.autoTrust, false);
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("persists channels and preserves them on re-read", () => {
    updateSettings({ channels: ["server:autonomos"] });
    const settings = getSettings();
    assert.deepEqual(settings.channels, ["server:autonomos"]);
  });

  it("persists empty channels array (opt-out)", () => {
    updateSettings({ channels: [] });
    const settings = getSettings();
    assert.deepEqual(settings.channels, []);
  });

  it("does not strip empty arrays", () => {
    updateSettings({ channels: [] });
    const settings = getSettings();
    assert.deepEqual(settings.channels, []);
  });
});

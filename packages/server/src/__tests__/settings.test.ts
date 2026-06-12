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

  it("scrubs removed keys (inboxAgent, gateway.telegram/discord) on read", () => {
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
    assert.deepEqual(settings.gateway, { slack: { enabled: true } });
  });

  it("drops scrubbed keys from disk on the next persist", () => {
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ inboxAgent: "Dispatcher", autoTrust: false }),
    );
    updateSettings({ terminalRenderer: "xterm" });
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
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ autoTrust: false, terminalRenderer: "ghostty-web" }),
    );
    const settings = getSettings();
    assert.equal(settings.autoTrust, false);
    assert.equal(settings.terminalRenderer, "ghostty-web");
    assert.deepEqual(settings.channels, ["server:autonomos"]);
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

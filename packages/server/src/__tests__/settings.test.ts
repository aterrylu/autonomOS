import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    const custom = [
      "server:autonomos",
      "plugin:discord@claude-plugins-official",
    ];
    writeFileSync(SETTINGS_FILE, JSON.stringify({ channels: custom }));
    const settings = getSettings();
    assert.deepEqual(settings.channels, custom);
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

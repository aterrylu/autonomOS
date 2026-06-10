import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultAppConfig } from "../../types/config.js";
import { CURRENT_SCHEMA_VERSION, migrateConfig } from "../config/migration.js";

/**
 * `migrateConfig` is the load-time gate for every byte of persisted desktop
 * config. It is pure (no electron) so it can be exercised directly. The
 * high-risk behaviors:
 *   - never trust hand-edited / corrupt config.json (defensive validation)
 *   - strip localhost "remote" duplicates of the synthesized This-Mac card
 *   - always normalize the result to CURRENT_SCHEMA_VERSION
 *   - never throw on garbage input (would brick the Welcome screen)
 */

describe("migrateConfig", () => {
  it("returns defaults for non-object input", () => {
    for (const garbage of [null, undefined, 42, "str", true, []]) {
      const out = migrateConfig(garbage as unknown);
      assert.deepEqual(out, defaultAppConfig());
      assert.equal(out.schemaVersion, CURRENT_SCHEMA_VERSION);
    }
  });

  it("normalizes any input to CURRENT_SCHEMA_VERSION", () => {
    const out = migrateConfig({ schemaVersion: 0, connections: [] });
    assert.equal(out.schemaVersion, CURRENT_SCHEMA_VERSION);
  });

  it("keeps a config already at the current version intact", () => {
    const input = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      connections: [
        {
          id: "abc",
          name: "Forge",
          type: "remote",
          url: "https://forge.example.com:7421",
        },
      ],
      openWindows: ["abc"],
      localServer: { installed: true },
      ui: { sidebarWidth: 333, theme: "dark" },
    };
    const out = migrateConfig(input);
    assert.equal(out.connections.length, 1);
    assert.equal(out.connections[0]?.id, "abc");
    assert.deepEqual(out.openWindows, ["abc"]);
    assert.equal(out.localServer.installed, true);
    assert.equal(out.ui.sidebarWidth, 333);
    assert.equal(out.ui.theme, "dark");
  });

  it("drops connection entries missing required fields (hand-edited file)", () => {
    const out = migrateConfig({
      connections: [
        { id: "ok", name: "Good", type: "remote", url: "https://h:1/" },
        { id: "", name: "no-id", type: "remote", url: "https://h:2/" },
        { id: "x", name: "bad-type", type: "wat", url: "https://h:3/" },
        { id: "y", name: "no-url", type: "remote", url: "" },
        { name: "missing-id", type: "remote", url: "https://h:4/" },
        "not-an-object",
      ],
    });
    assert.equal(out.connections.length, 1);
    assert.equal(out.connections[0]?.id, "ok");
  });

  it("strips localhost / 127.0.0.1 / 0.0.0.0 'remote' duplicates of the This-Mac card", () => {
    const out = migrateConfig({
      connections: [
        { id: "a", name: "lh", type: "remote", url: "http://localhost:5050" },
        { id: "b", name: "ip", type: "remote", url: "http://127.0.0.1:5050" },
        { id: "d", name: "zero", type: "remote", url: "http://0.0.0.0:5050" },
        { id: "e", name: "real", type: "remote", url: "https://forge.io:7421" },
      ],
    });
    // Only the genuinely-remote forge.io connection survives.
    assert.equal(out.connections.length, 1);
    assert.equal(out.connections[0]?.id, "e");
  });

  it("does NOT strip an IPv6 [::1] remote — pins a known gap in isLocalhostRemote", () => {
    // FINDING: `new URL("http://[::1]:5050").hostname` returns "[::1]" (with
    // brackets), but the source compares against "::1" (without). So the
    // IPv6-loopback branch is effectively dead — such a duplicate survives.
    // This test pins the *actual* behavior so a future fix is a deliberate,
    // visible change rather than a silent one.
    const out = migrateConfig({
      connections: [
        { id: "c", name: "v6", type: "remote", url: "http://[::1]:5050" },
      ],
    });
    assert.equal(out.connections.length, 1);
    assert.equal(out.connections[0]?.id, "c");
  });

  it("does NOT strip a local-type connection pointing at localhost", () => {
    // isLocalhostRemote only fires for type === "remote"; a synthesized
    // local card with a localhost url must survive.
    const out = migrateConfig({
      connections: [
        {
          id: "local",
          name: "This Mac",
          type: "local",
          url: "http://127.0.0.1:5050",
        },
      ],
    });
    assert.equal(out.connections.length, 1);
    assert.equal(out.connections[0]?.type, "local");
  });

  it("filters non-string entries out of openWindows", () => {
    const out = migrateConfig({
      openWindows: ["valid", "", 5, null, "another"],
    });
    assert.deepEqual(out.openWindows, ["valid", "another"]);
  });

  it("falls back to defaults for malformed nested fields", () => {
    const defaults = defaultAppConfig();
    const out = migrateConfig({
      connections: "not-an-array",
      openWindows: "not-an-array",
      localServer: { installed: "yes" },
      ui: { sidebarWidth: "wide", theme: "neon" },
    });
    assert.deepEqual(out.connections, defaults.connections);
    assert.deepEqual(out.openWindows, defaults.openWindows);
    assert.equal(out.localServer.installed, defaults.localServer.installed);
    assert.equal(out.ui.sidebarWidth, defaults.ui.sidebarWidth);
    assert.equal(out.ui.theme, defaults.ui.theme);
  });

  it("preserves a valid custom theme and sidebar width", () => {
    const out = migrateConfig({ ui: { sidebarWidth: 200, theme: "light" } });
    assert.equal(out.ui.sidebarWidth, 200);
    assert.equal(out.ui.theme, "light");
  });
});

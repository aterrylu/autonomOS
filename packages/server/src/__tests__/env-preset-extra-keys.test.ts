import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

/**
 * The operator's escape hatch (ADR-144): `envPresetExtraKeys` adds keys to
 * the env-preset allowlist for a provider that needs one autonomOS doesn't
 * know yet, so a missing allowlist entry can never block a user again (#496
 * blocked a real Kimi deployment). It's a SETTINGS field: the settings route
 * isn't on the agent API (agent-api.test.ts asserts PUT /api/settings is
 * unreachable with an agent credential), so only the operator can widen it.
 * It must never re-open what the allowlist closes: control-plane keys and
 * keys that make a CLI run code.
 */

const TEST_DIR = join(tmpdir(), `autonomos-extra-keys-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const { updateSettings } = await import("../settings.js");
const {
  applyPresetToEnv,
  createEnvPreset,
  isAllowedPresetKey,
  NEVER_PRESET_KEYS,
  PresetKeyError,
} = await import("../envPresets.js");
const { settingsRouter } = await import("../routes/settings.js");

const NOW = 1_700_000_000_000;
const CUSTOM = "ACME_GATEWAY_REGION"; // a key no built-in list will ever hold

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("envPresetExtraKeys widens the preset allowlist (operator only)", () => {
  it("a key the operator allowed can be saved in a preset and injects", () => {
    assert.throws(
      () =>
        createEnvPreset(
          { name: "acme", env: { ANTHROPIC_MODEL: "m", [CUSTOM]: "eu" } },
          NOW,
        ),
      (e: unknown) =>
        e instanceof PresetKeyError &&
        /Settings → Env presets → "Extra allowed keys"/.test(e.message),
      "precondition: unknown before the operator allows it, and the error says how",
    );
    updateSettings({ envPresetExtraKeys: [CUSTOM] });
    createEnvPreset(
      { name: "acme", env: { ANTHROPIC_MODEL: "m", [CUSTOM]: "eu" } },
      NOW,
    );
    const env: Record<string, string> = {};
    applyPresetToEnv(env, "acme");
    assert.equal(env[CUSTOM], "eu");
  });

  it("taking a key back off the list makes its presets refuse to spawn", () => {
    updateSettings({ envPresetExtraKeys: [CUSTOM] });
    createEnvPreset({ name: "acme2", env: { [CUSTOM]: "eu" } }, NOW);
    updateSettings({ envPresetExtraKeys: [] });
    assert.throws(
      () => applyPresetToEnv({}, "acme2"),
      new RegExp(`sets ${CUSTOM},.*NOT started`),
    );
  });

  it("can never allow a control-plane key or one that runs code, even written straight to settings", () => {
    updateSettings({
      envPresetExtraKeys: ["PATH", "AUTONOMOS_TOKEN", ...NEVER_PRESET_KEYS],
    });
    for (const k of ["PATH", "AUTONOMOS_TOKEN", ...NEVER_PRESET_KEYS]) {
      assert.equal(isAllowedPresetKey(k), false, k);
    }
  });
});

describe("PUT /api/settings envPresetExtraKeys", () => {
  const app = new Hono().route("/api/settings", settingsRouter);
  const put = (keys: unknown) =>
    app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envPresetExtraKeys: keys }),
    });

  it("saves valid keys (trimmed, deduped) and returns them", async () => {
    const res = await put([` ${CUSTOM} `, CUSTOM]);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { envPresetExtraKeys: string[] };
    assert.deepEqual(body.envPresetExtraKeys, [CUSTOM]);
  });

  it("refuses a key that runs code, a control-plane key and a malformed name, naming why", async () => {
    for (const [key, why] of [
      ["BASH_ENV", /run code/],
      ["CLAUDE_CONFIG_DIR", /run code or load config/],
      ["AUTONOMOS_TOKEN", /control-plane/],
      ["not a key", /not a valid environment variable name/],
    ] as const) {
      const res = await put([key]);
      assert.equal(res.status, 400, key);
      const { error } = (await res.json()) as { error: string };
      assert.match(error, new RegExp(`"${key}"`), key);
      assert.match(error, why, key);
    }
  });
});

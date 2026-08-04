import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// ── Test isolation ─────────────────────────────────────────────
// envPresets.ts reads CONFIG_DIR at import time (via configDir.ts →
// AUTONOMOS_CONFIG_DIR). Set it BEFORE importing. See schedules-crud.test.ts.
const TEST_DIR = join(tmpdir(), `autonomos-preset-test-${randomUUID()}`);
process.env.AUTONOMOS_CONFIG_DIR = TEST_DIR;

const {
  createEnvPreset,
  updateEnvPreset,
  deleteEnvPreset,
  getEnvPreset,
  getEnvPresetRaw,
  listEnvPresets,
  maskEnvPreset,
  resolvePresetEnv,
  applyPresetToEnv,
} = await import("../envPresets.js");

const PRESETS_DIR = join(TEST_DIR, "env-presets");
const NOW = 1_700_000_000_000;

beforeEach(() => {
  rmSync(PRESETS_DIR, { recursive: true, force: true });
  mkdirSync(PRESETS_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function kimiInput(overrides = {}) {
  return {
    name: `kimi-${randomUUID().slice(0, 8)}`,
    description: "Kimi K2.7-code",
    provider: "claude-code" as const,
    label: "Kimi",
    env: {
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_MODEL: "kimi-k2.7-code",
    },
    secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
    ...overrides,
  };
}

// ── masking ────────────────────────────────────────────────────

describe("maskEnvPreset", () => {
  it("redacts secret VALUES but leaves env plaintext", () => {
    const masked = maskEnvPreset({
      name: "p",
      env: { ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic" },
      secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
      secrets: { ANTHROPIC_AUTH_TOKEN: "sk-abcdefgh1234" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.equal(
      masked.env.ANTHROPIC_BASE_URL,
      "https://api.moonshot.ai/anthropic",
    );
    assert.equal(masked.secrets.ANTHROPIC_AUTH_TOKEN, "••••1234");
    assert.ok(
      !masked.secrets.ANTHROPIC_AUTH_TOKEN.includes("abcdefgh"),
      "the real secret must not appear in the masked form",
    );
  });

  it("fully masks a short secret (<= 8 chars)", () => {
    const masked = maskEnvPreset({
      name: "p",
      env: {},
      secretKeys: ["K"],
      secrets: { K: "short" },
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.equal(masked.secrets.K, "••••");
  });
});

// ── create ─────────────────────────────────────────────────────

describe("createEnvPreset", () => {
  it("creates a preset and returns it MASKED, with secrets empty for the agent path", () => {
    const p = createEnvPreset(kimiInput({ name: "kimi" }), NOW);
    assert.equal(p.name, "kimi");
    assert.equal(p.env.ANTHROPIC_MODEL, "kimi-k2.7-code");
    assert.deepEqual(p.secretKeys, ["ANTHROPIC_AUTH_TOKEN"]);
    assert.deepEqual(
      p.secrets,
      {},
      "agent-created preset has no secret values yet",
    );
  });

  it("persists to a file and never writes a plaintext secret via the agent path", () => {
    createEnvPreset(kimiInput({ name: "kimi" }), NOW);
    const raw = readFileSync(join(PRESETS_DIR, "kimi.json"), "utf-8");
    assert.ok(raw.includes("ANTHROPIC_BASE_URL"));
    assert.ok(
      !raw.includes("sk-"),
      "no secret value was supplied so none is on disk",
    );
  });

  it("accepts secret VALUES from the UI path and masks them on return", () => {
    const p = createEnvPreset(
      kimiInput({
        name: "kimi",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-live-9999" },
      }),
      NOW,
    );
    assert.equal(p.secrets.ANTHROPIC_AUTH_TOKEN, "••••9999");
    // but the real value IS on disk (0600) for the spawn path
    assert.equal(
      getEnvPresetRaw("kimi")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-live-9999",
    );
  });

  it("rejects a duplicate name", () => {
    createEnvPreset(kimiInput({ name: "kimi" }), NOW);
    assert.throws(
      () => createEnvPreset(kimiInput({ name: "kimi" }), NOW),
      /already exists/,
    );
  });

  it("rejects a reserved env key", () => {
    assert.throws(
      () =>
        createEnvPreset(
          kimiInput({ name: "bad", env: { PATH: "/evil" } }),
          NOW,
        ),
      /Reserved/,
    );
  });

  it("rejects a reserved secret key", () => {
    assert.throws(
      () =>
        createEnvPreset(
          kimiInput({ name: "bad", secretKeys: ["AUTONOMOS_AGENT_TOKEN"] }),
          NOW,
        ),
      /Reserved/,
    );
  });

  it("rejects a code-injection env key (LD_PRELOAD / NODE_OPTIONS / DYLD_*)", () => {
    for (const bad of ["LD_PRELOAD", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) {
      assert.throws(
        () =>
          createEnvPreset(kimiInput({ name: "bad", env: { [bad]: "x" } }), NOW),
        /Blocked/,
        `${bad} must be blocked`,
      );
    }
  });

  it("rejects a code-injection secret key too", () => {
    assert.throws(
      () =>
        createEnvPreset(
          kimiInput({ name: "bad", secretKeys: ["NODE_OPTIONS"] }),
          NOW,
        ),
      /Blocked/,
    );
  });

  it("rejects an invalid env-var name", () => {
    assert.throws(
      () =>
        createEnvPreset(
          kimiInput({ name: "bad", env: { "not a var": "x" } }),
          NOW,
        ),
      /Invalid env key/,
    );
  });

  it("rejects an unsafe preset name", () => {
    assert.throws(
      () => createEnvPreset(kimiInput({ name: "../escape" }), NOW),
      /Invalid preset name/,
    );
  });
});

// ── update: the secret-merge rules ─────────────────────────────

describe("updateEnvPreset — secret handling", () => {
  it("preserves an existing secret when the update carries none", () => {
    createEnvPreset(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-keepme-1" },
      }),
      NOW,
    );
    updateEnvPreset("k", { label: "Renamed" }, NOW + 1);
    assert.equal(
      getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-keepme-1",
    );
    assert.equal(getEnvPreset("k")?.label, "Renamed");
  });

  it("IGNORES a masked round-trip value (does not clobber the real secret with its mask)", () => {
    createEnvPreset(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-real-4242" },
      }),
      NOW,
    );
    // Simulate the UI PUTing back the masked read
    updateEnvPreset(
      "k",
      { secrets: { ANTHROPIC_AUTH_TOKEN: "••••4242" } },
      NOW + 1,
    );
    assert.equal(
      getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-real-4242",
      "the real secret must survive a masked round-trip",
    );
  });

  it("sets a new real secret value", () => {
    createEnvPreset(kimiInput({ name: "k" }), NOW);
    updateEnvPreset(
      "k",
      { secrets: { ANTHROPIC_AUTH_TOKEN: "sk-new-8888" } },
      NOW + 1,
    );
    assert.equal(
      getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-new-8888",
    );
  });

  it("clears a secret when given an empty string", () => {
    createEnvPreset(
      kimiInput({ name: "k", secrets: { ANTHROPIC_AUTH_TOKEN: "sk-clearme" } }),
      NOW,
    );
    updateEnvPreset("k", { secrets: { ANTHROPIC_AUTH_TOKEN: "" } }, NOW + 1);
    assert.equal(getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN, undefined);
  });

  it("preserves createdAt and bumps updatedAt", () => {
    createEnvPreset(kimiInput({ name: "k" }), NOW);
    const updated = updateEnvPreset("k", { label: "x" }, NOW + 5);
    assert.equal(updated.createdAt, NOW);
    assert.equal(updated.updatedAt, NOW + 5);
  });

  it("throws on a missing preset", () => {
    assert.throws(
      () => updateEnvPreset("nope", { label: "x" }, NOW),
      /not found/,
    );
  });
});

// ── delete / list ──────────────────────────────────────────────

describe("deleteEnvPreset / listEnvPresets", () => {
  it("deletes and reports missing", () => {
    createEnvPreset(kimiInput({ name: "k" }), NOW);
    assert.equal(deleteEnvPreset("k"), true);
    assert.equal(deleteEnvPreset("k"), false);
    assert.equal(getEnvPreset("k"), null);
  });

  it("lists all presets, MASKED", () => {
    createEnvPreset(
      kimiInput({
        name: "a",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-aaaa1111" },
      }),
      NOW,
    );
    createEnvPreset(kimiInput({ name: "b" }), NOW);
    const all = listEnvPresets();
    assert.deepEqual(Object.keys(all).sort(), ["a", "b"]);
    assert.equal(all.a.secrets.ANTHROPIC_AUTH_TOKEN, "••••1111");
  });
});

// ── resolvePresetEnv (spawn path) ──────────────────────────────

describe("resolvePresetEnv", () => {
  it("merges non-secret env + REAL secret values for injection", () => {
    createEnvPreset(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-inject-me" },
      }),
      NOW,
    );
    const resolved = resolvePresetEnv("k");
    assert.equal(
      resolved?.env.ANTHROPIC_BASE_URL,
      "https://api.moonshot.ai/anthropic",
    );
    assert.equal(resolved?.env.ANTHROPIC_AUTH_TOKEN, "sk-inject-me");
    assert.deepEqual(resolved?.missingSecrets, []);
  });

  it("reports a declared-but-unset secret as missing (blocks spawn)", () => {
    createEnvPreset(kimiInput({ name: "k" }), NOW);
    assert.deepEqual(resolvePresetEnv("k")?.missingSecrets, [
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });

  it("returns null for a missing preset", () => {
    assert.equal(resolvePresetEnv("nope"), null);
  });

  it("strips a reserved key even if one reached the file (defense-in-depth)", () => {
    // Write a file directly, bypassing create-time validation, to prove the
    // injection-time guard also strips reserved keys.
    writeFileSync(
      join(PRESETS_DIR, "tainted.json"),
      JSON.stringify({
        name: "tainted",
        env: { AUTONOMOS_AGENT_TOKEN: "forged", ANTHROPIC_MODEL: "kimi-k3" },
        secretKeys: [],
        secrets: {},
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const resolved = resolvePresetEnv("tainted");
    assert.equal(
      resolved?.env.AUTONOMOS_AGENT_TOKEN,
      undefined,
      "reserved key stripped",
    );
    assert.equal(resolved?.env.ANTHROPIC_MODEL, "kimi-k3");
  });

  it("strips a code-injection key too, if one reached the file", () => {
    writeFileSync(
      join(PRESETS_DIR, "tainted2.json"),
      JSON.stringify({
        name: "tainted2",
        env: { LD_PRELOAD: "/evil.so", ANTHROPIC_MODEL: "kimi-k3" },
        secretKeys: [],
        secrets: {},
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const resolved = resolvePresetEnv("tainted2");
    assert.equal(
      resolved?.env.LD_PRELOAD,
      undefined,
      "code-injection key stripped",
    );
    assert.equal(resolved?.env.ANTHROPIC_MODEL, "kimi-k3");
  });

  it("injects ONLY declared secretKeys — an orphaned secret value is not exported", () => {
    writeFileSync(
      join(PRESETS_DIR, "orphan.json"),
      JSON.stringify({
        name: "orphan",
        env: {},
        secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-declared", OLD_KEY: "sk-orphan" },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const resolved = resolvePresetEnv("orphan");
    assert.equal(resolved?.env.ANTHROPIC_AUTH_TOKEN, "sk-declared");
    assert.equal(
      resolved?.env.OLD_KEY,
      undefined,
      "undeclared orphan secret not injected",
    );
  });

  it("never exports a masked literal that reached disk", () => {
    writeFileSync(
      join(PRESETS_DIR, "masked.json"),
      JSON.stringify({
        name: "masked",
        env: {},
        secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
        secrets: { ANTHROPIC_AUTH_TOKEN: "••••1234" },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const resolved = resolvePresetEnv("masked");
    assert.equal(
      resolved?.env.ANTHROPIC_AUTH_TOKEN,
      undefined,
      "masked literal not injected",
    );
  });
});

// ── secret pruning (no orphaned plaintext on disk) ─────────────

describe("updateEnvPreset — secret pruning (Nox)", () => {
  it("drops an undeclared secret value from DISK when its key is removed", () => {
    createEnvPreset(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-orphan-me" },
      }),
      NOW,
    );
    // Remove the declared key (e.g. a rename to a new key name).
    updateEnvPreset("k", { secretKeys: [] }, NOW + 1);
    // The plaintext value must be gone from the file, not just un-injected.
    assert.deepEqual(getEnvPresetRaw("k")?.secrets, {});
  });

  it("keeps a still-declared secret when other fields change", () => {
    createEnvPreset(
      kimiInput({ name: "k", secrets: { ANTHROPIC_AUTH_TOKEN: "sk-keep" } }),
      NOW,
    );
    updateEnvPreset("k", { label: "x" }, NOW + 1);
    assert.equal(getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN, "sk-keep");
  });
});

// ── applyPresetToEnv (spawn-time contract) ─────────────────────

describe("applyPresetToEnv", () => {
  it("merges the preset's resolved env into the target", () => {
    createEnvPreset(
      kimiInput({ name: "k", secrets: { ANTHROPIC_AUTH_TOKEN: "sk-real" } }),
      NOW,
    );
    const env: Record<string, string> = { EXISTING: "keep" };
    applyPresetToEnv(env, "k");
    assert.equal(env.EXISTING, "keep");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://api.moonshot.ai/anthropic");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-real");
  });

  it("REFUSES (throws) when a declared API key is unset — no half-spawn", () => {
    createEnvPreset(kimiInput({ name: "k" }), NOW); // no secret value
    const env: Record<string, string> = {};
    assert.throws(() => applyPresetToEnv(env, "k"), /missing its API key/);
    assert.deepEqual(env, {}, "target env untouched on refusal");
  });

  it("throws when the preset does not exist", () => {
    assert.throws(() => applyPresetToEnv({}, "nope"), /not found/);
  });
});

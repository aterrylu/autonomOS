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
  PresetKeyError,
  PRESET_ALLOWED_ENV_KEYS,
  skippedPresetKeysNotice,
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

/**
 * The HUMAN (dashboard REST) write path. The store strips secret VALUES unless
 * a caller opts in, so every test that needs a credential ON DISK has to say so
 * — which is the boundary itself, asserted by "the default write path strips…"
 * below. Agent-surface behaviour is the plain `createEnvPreset` call.
 */
function createWithSecrets(
  input: Parameters<typeof createEnvPreset>[0],
  now: number,
) {
  return createEnvPreset(input, now, { writeSecrets: true });
}
function updateWithSecrets(
  name: string,
  partial: Parameters<typeof updateEnvPreset>[1],
  now: number,
) {
  return updateEnvPreset(name, partial, now, { writeSecrets: true });
}

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
    const p = createWithSecrets(
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

  it("the DEFAULT write path STRIPS secret values — an agent cannot set a credential", () => {
    // The store, not the schema, is what enforces this. Omitting `secrets` from
    // the MCP tool shapes only holds for as long as every surface remembers to;
    // here a caller that passes values WITHOUT opting in gets none on disk, so
    // a new surface is safe by construction.
    createEnvPreset(
      kimiInput({
        name: "kimi",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-agent-set-me" },
      }),
      NOW,
    );
    assert.deepEqual(getEnvPresetRaw("kimi")?.secrets, {});
    const raw = readFileSync(join(PRESETS_DIR, "kimi.json"), "utf-8");
    assert.ok(
      !raw.includes("sk-agent-set-me"),
      "the value must not reach disk at all, masked or otherwise",
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

  it("rejects a code-injection env key (LD_PRELOAD / NODE_OPTIONS / DYLD_*): not on the allowlist", () => {
    for (const bad of ["LD_PRELOAD", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) {
      assert.throws(
        () =>
          createEnvPreset(kimiInput({ name: "bad", env: { [bad]: "x" } }), NOW),
        /can't be set by a preset/,
        `${bad} must be refused`,
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
      /can't be set by a preset/,
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
  it("the DEFAULT update path STRIPS secret values too", () => {
    createWithSecrets(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-original" },
      }),
      NOW,
    );
    // No opt-in: the new value is dropped and the stored one is untouched.
    updateEnvPreset(
      "k",
      { secrets: { ANTHROPIC_AUTH_TOKEN: "sk-agent-overwrite" } },
      NOW + 1,
    );
    assert.equal(
      getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-original",
    );
  });

  it("preserves an existing secret when the update carries none", () => {
    createWithSecrets(
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
    createWithSecrets(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-real-4242" },
      }),
      NOW,
    );
    // Simulate the UI PUTing back the masked read
    updateWithSecrets(
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
    updateWithSecrets(
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
    createWithSecrets(
      kimiInput({ name: "k", secrets: { ANTHROPIC_AUTH_TOKEN: "sk-clearme" } }),
      NOW,
    );
    assert.equal(
      getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-clearme",
      "precondition: there is a stored secret to clear",
    );
    updateWithSecrets("k", { secrets: { ANTHROPIC_AUTH_TOKEN: "" } }, NOW + 1);
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
    createWithSecrets(
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
    createWithSecrets(
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
    createWithSecrets(
      kimiInput({
        name: "k",
        secrets: { ANTHROPIC_AUTH_TOKEN: "sk-orphan-me" },
      }),
      NOW,
    );
    assert.equal(
      getEnvPresetRaw("k")?.secrets.ANTHROPIC_AUTH_TOKEN,
      "sk-orphan-me",
      "precondition: there is a plaintext value to orphan",
    );
    // Remove the declared key (e.g. a rename to a new key name).
    updateEnvPreset("k", { secretKeys: [] }, NOW + 1);
    // The plaintext value must be gone from the file, not just un-injected.
    assert.deepEqual(getEnvPresetRaw("k")?.secrets, {});
  });

  it("keeps a still-declared secret when other fields change", () => {
    createWithSecrets(
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
    createWithSecrets(
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

// ── Security audit V13 (ADR-143): an allowlist, not a denylist ──────────
// The old denylist blocked LD_PRELOAD/NODE_OPTIONS/DYLD_* and ADR-067 claimed
// that stopped a preset from running code in another agent's process. These
// keys got through it and each one does exactly that (or redirects the
// agent's config/credentials): every one was accepted and injected on main.
const AUDIT_BYPASS_KEYS = [
  "BASH_ENV",
  "ZDOTDIR",
  "SHELL",
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_GLOBAL",
  "BUN_OPTIONS",
];

/** A preset file written before the allowlist existed: validation never ran
 *  on it under the new rules. */
function writeLegacyPreset(name: string, extra: Record<string, string>) {
  writeFileSync(
    join(PRESETS_DIR, `${name}.json`),
    JSON.stringify({
      name,
      env: {
        ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
        ANTHROPIC_MODEL: "kimi-k2.7-code",
        ...extra,
      },
      secretKeys: ["ANTHROPIC_AUTH_TOKEN", "GIT_SSH_COMMAND"],
      secrets: {
        ANTHROPIC_AUTH_TOKEN: "sk-real-key-0000",
        GIT_SSH_COMMAND: "ssh -o ProxyCommand=evil",
      },
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

describe("env presets: strict key allowlist (audit V13)", () => {
  it("refuses every key the old denylist let through, as env or as a secret", () => {
    for (const key of AUDIT_BYPASS_KEYS) {
      assert.throws(
        () => createEnvPreset(kimiInput({ env: { [key]: "x" } }), NOW),
        PresetKeyError,
        `env ${key} must be refused`,
      );
      assert.throws(
        () => createEnvPreset(kimiInput({ secretKeys: [key] }), NOW),
        PresetKeyError,
        `secret ${key} must be refused`,
      );
      assert.throws(
        () =>
          updateEnvPreset(
            createEnvPreset(kimiInput(), NOW).name,
            { env: { [key]: "x" } },
            NOW,
          ),
        PresetKeyError,
        `update adding ${key} must be refused`,
      );
    }
  });

  it("the documented Kimi preset is accepted and injects fully", () => {
    const p = createWithSecrets(
      kimiInput({ secrets: { ANTHROPIC_AUTH_TOKEN: "sk-kimi-123456789" } }),
      NOW,
    );
    const env: Record<string, string> = {};
    const skipped = applyPresetToEnv(env, p.name);
    assert.deepEqual(skipped, []);
    assert.deepEqual(env, {
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_MODEL: "kimi-k2.7-code",
      ANTHROPIC_AUTH_TOKEN: "sk-kimi-123456789",
    });
  });

  it("allows proxy and CA-trust settings (an explicit operator choice)", () => {
    const net = {
      HTTPS_PROXY: "http://proxy.corp:3128",
      https_proxy: "http://proxy.corp:3128",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      SSL_CERT_FILE: "/etc/corp-ca.pem",
      REQUESTS_CA_BUNDLE: "/etc/corp-ca.pem",
    };
    const p = createEnvPreset(kimiInput({ env: net, secretKeys: [] }), NOW);
    const env: Record<string, string> = {};
    applyPresetToEnv(env, p.name);
    for (const [k, v] of Object.entries(net)) assert.equal(env[k], v, k);
  });

  it("never allowlists a control-plane key", () => {
    for (const k of [
      "PATH",
      "HOME",
      "AUTONOMOS_TOKEN",
      "AUTONOMOS_CONFIG_DIR",
    ]) {
      assert.equal(PRESET_ALLOWED_ENV_KEYS.has(k), false, k);
    }
  });

  it("a preset saved before the allowlist still spawns, without its off-list keys", () => {
    writeLegacyPreset("legacy", {
      BASH_ENV: "/tmp/evil.sh",
      ZDOTDIR: "/tmp/z",
    });
    const env: Record<string, string> = {};
    const skipped = applyPresetToEnv(env, "legacy");
    assert.deepEqual(skipped, ["BASH_ENV", "GIT_SSH_COMMAND", "ZDOTDIR"]);
    assert.deepEqual(env, {
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_MODEL: "kimi-k2.7-code",
      ANTHROPIC_AUTH_TOKEN: "sk-real-key-0000",
    });
    const notice = skippedPresetKeysNotice("worker", "legacy", skipped);
    assert.match(notice, /BASH_ENV, GIT_SSH_COMMAND, ZDOTDIR/);
    assert.match(notice, /NOT applied/);
  });

  it("an off-list declared secret with no value doesn't block the spawn", () => {
    writeFileSync(
      join(PRESETS_DIR, "legacy2.json"),
      JSON.stringify({
        name: "legacy2",
        env: { ANTHROPIC_MODEL: "kimi-k2.7-code" },
        secretKeys: ["BUN_OPTIONS"],
        secrets: {},
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const env: Record<string, string> = {};
    assert.deepEqual(applyPresetToEnv(env, "legacy2"), ["BUN_OPTIONS"]);
    assert.equal(env.ANTHROPIC_MODEL, "kimi-k2.7-code");
  });

  it("a legacy preset stays editable: a description change and a dashboard round-trip both work", () => {
    writeLegacyPreset("legacy3", { BASH_ENV: "/tmp/evil.sh" });
    updateEnvPreset("legacy3", { description: "renamed" }, NOW);
    // The dashboard sends every secret back masked; that sets nothing.
    const masked = getEnvPreset("legacy3");
    updateWithSecrets("legacy3", { secrets: masked?.secrets }, NOW);
    // Removing the off-list keys is an ordinary edit.
    updateWithSecrets(
      "legacy3",
      {
        env: { ANTHROPIC_MODEL: "kimi-k2.7-code" },
        secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
      },
      NOW,
    );
    const env: Record<string, string> = {};
    assert.deepEqual(applyPresetToEnv(env, "legacy3"), []);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-real-key-0000");
  });

  it("a dashboard edit of a legacy preset works: it re-sends the off-list key, but adds nothing", () => {
    // PresetsPanel's saveEdit always PUTs the FULL env and secretKeys (nox on
    // #496), so a description change on a legacy preset arrives carrying its
    // off-list keys. Only keys the edit ADDS are validated.
    writeLegacyPreset("legacy5", { BASH_ENV: "/tmp/evil.sh" });
    const onDisk = getEnvPresetRaw("legacy5");
    assert.ok(onDisk?.env.BASH_ENV, "precondition: the legacy key is on disk");
    const dashboardPayload = {
      description: "renamed from the Presets tab",
      label: "Kimi",
      provider: "claude-code" as const,
      env: { ...onDisk.env },
      secretKeys: [...onDisk.secretKeys],
    };
    updateEnvPreset("legacy5", dashboardPayload, NOW);
    assert.equal(
      getEnvPresetRaw("legacy5")?.description,
      "renamed from the Presets tab",
    );
    // A kept off-list key is still never injected.
    const env: Record<string, string> = {};
    assert.deepEqual(applyPresetToEnv(env, "legacy5"), [
      "BASH_ENV",
      "GIT_SSH_COMMAND",
    ]);
    assert.equal(env.BASH_ENV, undefined);
    // Adding a NEW off-list key in the same kind of edit is refused.
    assert.throws(
      () =>
        updateEnvPreset(
          "legacy5",
          {
            ...dashboardPayload,
            env: { ...dashboardPayload.env, SHELL: "/tmp/sh" },
          },
          NOW,
        ),
      PresetKeyError,
    );
    assert.throws(
      () =>
        updateEnvPreset(
          "legacy5",
          {
            ...dashboardPayload,
            secretKeys: [...dashboardPayload.secretKeys, "BUN_OPTIONS"],
          },
          NOW,
        ),
      PresetKeyError,
    );
  });

  it("an edit can't SET a value for an off-list secret", () => {
    writeLegacyPreset("legacy4", {});
    assert.throws(
      () =>
        updateWithSecrets(
          "legacy4",
          { secrets: { GIT_SSH_COMMAND: "ssh -x" } },
          NOW,
        ),
      PresetKeyError,
    );
  });
});

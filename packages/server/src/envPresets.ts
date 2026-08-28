/**
 * Env-preset CRUD — reads/writes ~/.autonomos/env-presets/<name>.json (0600).
 *
 * Mirrors the templates.ts / schedules.ts pattern: one JSON file per preset,
 * name-validated for path safety. See core/types/envPreset.ts and ADR-067 for
 * the credential boundary. The rules enforced HERE:
 *
 *   - `env` (non-secret) and `secretKeys` (declared secret names) are freely
 *     read/written — this is the agent-managed surface.
 *   - `secrets` (values) are stored on disk (0600) but NEVER returned in
 *     plaintext: every read goes through `maskEnvPreset`. `getEnvPresetRaw`
 *     (unmasked) exists solely for the spawn path and is not wired to any
 *     REST/MCP response.
 *   - WRITING a secret value requires an explicit `writeSecrets` opt-in. Both
 *     write paths strip them otherwise (`stripSecrets`), so "agents cannot set
 *     a credential" is enforced here rather than by every surface remembering
 *     to leave the field out of its schema.
 *   - On update, a secret value that is empty CLEARS the key, and a value that
 *     is already masked (a UI round-trip of the redacted form) is IGNORED so it
 *     can't overwrite the real stored secret with the mask.
 *   - No preset may set a RESERVED_ENV_KEY (control-plane / identity vars).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EnvPreset, Provider } from "@autonomos/core";
import { SECRET_MASK } from "@autonomos/core";
import { getConfigDir } from "./configDir.js";
import { RESERVED_ENV_KEYS } from "./providers/shared.js";

// Per-call (not module-load) so the configDir test-escape guard applies and
// env-based isolation set in a before-hook is honored (#272 class).
const PRESETS_DIR = () => join(getConfigDir(), "env-presets");

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Env keys that make a spawned process load/execute arbitrary code at startup.
 * Distinct from RESERVED_ENV_KEYS (control-plane identity): these don't break
 * autonomOS, they turn a "model override" into remote code execution INSIDE the
 * spawned agent's `claude`/`node` process. An agent holding the main token can
 * already curl the REST API, but it cannot otherwise run code in a SIBLING
 * agent's process — a preset `LD_PRELOAD` would grant exactly that, a genuinely
 * new vector (ADR-067). Rejected at create/update AND stripped at injection.
 */
const DANGEROUS_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "NODE_OPTIONS",
  "BUN_INSPECT",
]);

/** Keys neither a user nor an agent may put in a preset — control-plane
 *  identity (RESERVED) plus code-injection vectors (DANGEROUS). */
function isBlockedKey(key: string): boolean {
  return RESERVED_ENV_KEYS.has(key) || DANGEROUS_ENV_KEYS.has(key);
}

function validateName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid preset name "${name}": must be lowercase letters, digits, and hyphens`,
    );
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Validate an env-var key: syntactically valid AND not a reserved control key. */
function validateEnvKeys(keys: Iterable<string>, kind: "env" | "secret"): void {
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(
        `Invalid ${kind} key "${key}": not a valid environment variable name`,
      );
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      throw new Error(
        `Reserved ${kind} key "${key}": presets may not override autonomOS control-plane variables`,
      );
    }
    if (DANGEROUS_ENV_KEYS.has(key)) {
      throw new Error(
        `Blocked ${kind} key "${key}": presets may not set code-injection env vars (LD_PRELOAD, DYLD_*, NODE_OPTIONS, …)`,
      );
    }
  }
}

/** Redact a secret value — show only the last 4 chars. Mirrors routes/settings.ts. */
function redact(value: string): string {
  if (value.length <= 8) return SECRET_MASK;
  return `${SECRET_MASK}${value.slice(-4)}`;
}

/** Return a copy with every secret VALUE redacted. The shape a read boundary
 *  (REST GET, MCP list) must return — never the raw preset. */
export function maskEnvPreset(preset: EnvPreset): EnvPreset {
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(preset.secrets)) secrets[k] = redact(v);
  return { ...preset, secrets };
}

// ── CRUD ────────────────────────────────────────────────────────

/** Read a preset with REAL secret values. Spawn-path only — do NOT return this
 *  from any REST/MCP handler; use maskEnvPreset first. */
export function getEnvPresetRaw(name: string): EnvPreset | null {
  validateName(name);
  const filePath = join(PRESETS_DIR(), `${name}.json`);
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as EnvPreset;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw new Error(
      `Failed to load preset "${name}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Masked read (safe for any response). */
export function getEnvPreset(name: string): EnvPreset | null {
  const raw = getEnvPresetRaw(name);
  return raw ? maskEnvPreset(raw) : null;
}

function writePreset(preset: EnvPreset): void {
  validateName(preset.name);
  ensureDir(PRESETS_DIR());
  writeFileSync(
    join(PRESETS_DIR(), `${preset.name}.json`),
    `${JSON.stringify(preset, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

export interface EnvPresetInput {
  name: string;
  description?: string;
  provider?: Provider;
  label?: string;
  env?: Record<string, string>;
  secretKeys?: string[];
  /** Secret VALUES. Honored only when the caller passes `writeSecrets` (the
   *  dashboard REST route); stripped by default. Empty string clears; a masked
   *  value is ignored. */
  secrets?: Record<string, string>;
}

export interface EnvPresetWriteOptions {
  /**
   * Let `input.secrets` reach disk. The HUMAN surface only — the dashboard
   * Presets tab is where an API key is entered.
   *
   * The default is to STRIP, which is what makes ADR-067's asymmetry an
   * enforced boundary instead of a convention. Omitting `secrets` from the MCP
   * tool schemas keeps an agent from setting a credential only for as long as
   * every present and future surface remembers to omit it; stripping at the
   * store means a new surface — a channel dispatch, a webhook, a CLI — is safe
   * by construction and has to opt in loudly to be otherwise.
   *
   * It does NOT change the read side, which was already a hard wall
   * (`maskEnvPreset`), nor the caveat that a spawned agent holds the real key
   * in its env.
   */
  writeSecrets?: boolean;
}

/**
 * Return `input` without secret VALUES. Exported so a caller can state the
 * boundary explicitly; every write path runs it unless `writeSecrets` is set.
 */
export function stripSecrets<T extends { secrets?: Record<string, string> }>(
  input: T,
): Omit<T, "secrets"> {
  const { secrets: _dropped, ...rest } = input;
  return rest;
}

/** One place both write paths agree on: strip unless the caller opted in. */
function applyWritePolicy<T extends { secrets?: Record<string, string> }>(
  input: T,
  opts: EnvPresetWriteOptions,
): T | Omit<T, "secrets"> {
  return opts.writeSecrets ? input : stripSecrets(input);
}

/** Merge incoming secret values onto existing, honoring the boundary rules:
 *  empty → clear; masked round-trip → keep existing; real value → set. */
function mergeSecrets(
  existing: Record<string, string>,
  incoming: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming ?? {})) {
    if (typeof v !== "string") continue;
    if (v === "") {
      delete out[k];
    } else if (v.startsWith(SECRET_MASK)) {
      // masked round-trip from a prior read — do not clobber the real secret
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Drop secret VALUES whose key is not (any longer) declared in `secretKeys`.
 * Without this, removing or renaming a secretKey would orphan its plaintext
 * value in the 0600 file forever — the UI only renders declared keys, so the
 * human can't see or clear it, and "I removed that key" wouldn't remove the
 * credential. Enforced on every write so `secrets ⊆ secretKeys` is an invariant
 * on disk, not just at injection.
 */
function pruneSecrets(
  secrets: Record<string, string>,
  declaredKeys: string[],
): Record<string, string> {
  const declared = new Set(declaredKeys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (declared.has(k)) out[k] = v;
  }
  return out;
}

/** Create a new preset. Throws if one already exists. Returns the MASKED form.
 *  Secret values are stripped unless `opts.writeSecrets` — see the option. */
export function createEnvPreset(
  rawInput: EnvPresetInput,
  now: number,
  opts: EnvPresetWriteOptions = {},
): EnvPreset {
  const input = applyWritePolicy(rawInput, opts);
  validateName(input.name);
  if (getEnvPresetRaw(input.name)) {
    throw new Error(`Preset "${input.name}" already exists`);
  }
  const env = input.env ?? {};
  const secretKeys = input.secretKeys ?? [];
  validateEnvKeys(Object.keys(env), "env");
  validateEnvKeys(secretKeys, "secret");
  const secrets = pruneSecrets(
    mergeSecrets({}, "secrets" in input ? input.secrets : undefined),
    secretKeys,
  );
  validateEnvKeys(Object.keys(secrets), "secret");
  const preset: EnvPreset = {
    name: input.name,
    description: input.description,
    provider: input.provider,
    label: input.label,
    env,
    secretKeys,
    secrets,
    createdAt: now,
    updatedAt: now,
  };
  writePreset(preset);
  return maskEnvPreset(preset);
}

/** Partial update. Preserves secrets not re-supplied (see mergeSecrets).
 *  Returns the MASKED form. Throws if not found. */
export function updateEnvPreset(
  name: string,
  rawPartial: Omit<EnvPresetInput, "name">,
  now: number,
  opts: EnvPresetWriteOptions = {},
): EnvPreset {
  const partial = applyWritePolicy(rawPartial, opts);
  const existing = getEnvPresetRaw(name);
  if (!existing) throw new Error(`Preset "${name}" not found`);
  if (partial.env) validateEnvKeys(Object.keys(partial.env), "env");
  if (partial.secretKeys) validateEnvKeys(partial.secretKeys, "secret");
  const finalSecretKeys = partial.secretKeys ?? existing.secretKeys;
  // Prune to the FINAL declared keys so removing/renaming a secretKey drops its
  // orphaned plaintext value from disk rather than leaving it invisibly (Nox).
  const secrets = pruneSecrets(
    mergeSecrets(
      existing.secrets,
      "secrets" in partial ? partial.secrets : undefined,
    ),
    finalSecretKeys,
  );
  validateEnvKeys(Object.keys(secrets), "secret");
  const updated: EnvPreset = {
    ...existing,
    description: partial.description ?? existing.description,
    provider: partial.provider ?? existing.provider,
    label: partial.label ?? existing.label,
    env: partial.env ?? existing.env,
    secretKeys: finalSecretKeys,
    secrets,
    name: existing.name,
    createdAt: existing.createdAt,
    updatedAt: now,
  };
  writePreset(updated);
  return maskEnvPreset(updated);
}

export function deleteEnvPreset(name: string): boolean {
  validateName(name);
  try {
    unlinkSync(join(PRESETS_DIR(), `${name}.json`));
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    )
      return false;
    throw new Error(
      `Failed to delete preset "${name}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** All presets, MASKED. */
export function listEnvPresets(): Record<string, EnvPreset> {
  ensureDir(PRESETS_DIR());
  const result: Record<string, EnvPreset> = {};
  for (const file of readdirSync(PRESETS_DIR())) {
    if (!file.endsWith(".json")) continue;
    const name = file.replace(/\.json$/, "");
    try {
      const preset = getEnvPreset(name);
      if (preset) result[name] = preset;
    } catch (err) {
      console.warn(
        `Skipping corrupt preset "${name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

// ── Spawn resolution ────────────────────────────────────────────

export interface ResolvedPresetEnv {
  /** Injectable env (env + real secrets), with reserved keys stripped. */
  env: Record<string, string>;
  /** Declared secret keys that have no value set — spawn should refuse. */
  missingSecrets: string[];
}

/**
 * Resolve a preset for injection at spawn. Merges non-secret env + real secret
 * values, strips any reserved key (defense-in-depth beyond create-time
 * validation), and reports declared secret keys that are still unset so the
 * caller can refuse the spawn with a clear message. Returns null if the named
 * preset doesn't exist.
 */
export function resolvePresetEnv(name: string): ResolvedPresetEnv | null {
  const raw = getEnvPresetRaw(name);
  if (!raw) return null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.env)) {
    if (!isBlockedKey(k)) env[k] = v;
  }
  // Inject ONLY secrets whose key is currently DECLARED in secretKeys. An
  // orphaned value left on disk after a secretKey was renamed/removed must not
  // leak into the agent (it wouldn't show in the UI either) — inject-what-you-
  // declare keeps disk, UI, and process env in agreement. Also never export a
  // masked literal that reached disk by any means, nor a blocked key.
  const declared = new Set(raw.secretKeys);
  for (const [k, v] of Object.entries(raw.secrets)) {
    if (declared.has(k) && !isBlockedKey(k) && !v.startsWith(SECRET_MASK)) {
      env[k] = v;
    }
  }
  const missingSecrets = raw.secretKeys.filter((k) => !raw.secrets[k]);
  return { env, missingSecrets };
}

/**
 * Merge a preset's resolved env into `target` (mutating it), or THROW if the
 * preset doesn't exist or a declared API key is unset. This is the exact
 * spawn-time contract (ADR-067 decision 5), extracted from runtime.ts so the
 * two headline behaviors — "the preset's vars reach the process env" and
 * "a keyless preset refuses to spawn" — are unit-testable without a PTY.
 */
export function applyPresetToEnv(
  target: Record<string, string>,
  presetName: string,
): void {
  const resolved = resolvePresetEnv(presetName);
  if (!resolved) throw new Error(`Env preset "${presetName}" not found`);
  if (resolved.missingSecrets.length > 0) {
    throw new Error(
      `Env preset "${presetName}" is missing its API key (${resolved.missingSecrets.join(", ")}). ` +
        `Ask a human to set it in the dashboard Presets tab before spawning an agent with this preset.`,
    );
  }
  for (const [k, v] of Object.entries(resolved.env)) target[k] = v;
}

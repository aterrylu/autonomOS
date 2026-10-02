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
 *   - A preset may set ONLY the keys in PRESET_ALLOWED_ENV_KEYS (security audit
 *     V13, ADR-143): model, endpoint and auth variables, plus proxy and CA
 *     trust. New and edited presets are refused any other key; a preset saved
 *     before the allowlist still loads, and its other keys are skipped at
 *     spawn with a notice naming them.
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
import { getSettings } from "./settings.js";

// Per-call (not module-load) so the configDir test-escape guard applies and
// env-based isolation set in a before-hook is honored (#272 class).
const PRESETS_DIR = () => join(getConfigDir(), "env-presets");

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The ONLY keys a preset may set (security audit V13, ADR-143; corrects
 * ADR-067). A preset exists to point an agent at another model backend, so it
 * gets the variables that choose a model, an endpoint and its credentials, and
 * nothing else. The old denylist (LD_PRELOAD, NODE_OPTIONS, …) claimed to stop
 * a preset from running code in another agent's process, but it let through
 * BASH_ENV, ZDOTDIR, SHELL, CLAUDE_CODE_SHELL_PREFIX, CLAUDE_CONFIG_DIR,
 * GIT_SSH_COMMAND, BUN_OPTIONS and more. A denylist can't be complete; an
 * allowlist is complete by construction. Adding a backend's variable is one
 * line here.
 *
 * Proxy and CA-trust variables are allowed because a corporate network needs
 * them to reach any backend. They CAN route an agent's traffic through an
 * interceptor (a proxy, or a CA that makes one trusted), so setting them is an
 * explicit operator choice under ADR-067's trusted-fleet model.
 */
export const PRESET_ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
  // ── Claude Code: endpoint and auth (code.claude.com/docs/en/env-vars) ──
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS", // plain "Name: Value" lines; runs nothing
  "ANTHROPIC_BETAS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  // ── Claude Code: which model each role uses (every provider guide sets
  //    some of these; Kimi's official guide sets all four DEFAULT_*s,
  //    including FABLE, which #496 missed) ──
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  ...["FABLE", "OPUS", "SONNET", "HAIKU"].flatMap((f) => [
    `ANTHROPIC_DEFAULT_${f}_MODEL`,
    `ANTHROPIC_DEFAULT_${f}_MODEL_NAME`,
    `ANTHROPIC_DEFAULT_${f}_MODEL_DESCRIPTION`,
    `ANTHROPIC_DEFAULT_${f}_MODEL_SUPPORTED_CAPABILITIES`,
  ]),
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  // ── Claude Code: request tuning a backend's guide sets (Kimi, GLM,
  //    DeepSeek, MiniMax, Qwen: context window, effort, timeouts) ──
  "API_TIMEOUT_MS",
  "API_FORCE_IDLE_TIMEOUT",
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_STREAM_IDLE_TIMEOUT_MS",
  "CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS",
  "CLAUDE_ENABLE_STREAM_WATCHDOG",
  "CLAUDE_ENABLE_BYTE_WATCHDOG",
  "CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK",
  "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
  "FALLBACK_FOR_ALL_PRIMARY_MODELS",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
  "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP",
  "CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK",
  "CLAUDE_CODE_DISABLE_FAST_MODE",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  "CLAUDE_CODE_EXTRA_BODY", // JSON merged into requests; runs nothing
  "ENABLE_TOOL_SEARCH",
  "DISABLE_PROMPT_CACHING",
  "DISABLE_PROMPT_CACHING_FABLE",
  "DISABLE_PROMPT_CACHING_HAIKU",
  "DISABLE_PROMPT_CACHING_OPUS",
  "DISABLE_PROMPT_CACHING_SONNET",
  "ENABLE_PROMPT_CACHING_1H",
  "FORCE_PROMPT_CACHING_5M",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
  // ── Claude Code: gateways (OpenRouter, Vercel AI Gateway, LiteLLM) ──
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS",
  "CLAUDE_CODE_GATEWAY_HINT_HEADERS",
  "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK",
  "CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS",
  // ── Claude Code: traffic and telemetry OPT-OUTS (they send less) ──
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_TELEMETRY",
  "DO_NOT_TRACK",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_COST_WARNINGS",
  "DISABLE_AUTOUPDATER",
  // ── Claude Code on Bedrock / Mantle / Claude Platform on AWS
  //    (docs/en/amazon-bedrock) ──
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_DEFAULT",
  "CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD",
  "CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS",
  "CLAUDE_CODE_SKIP_AWS_CRED_CACHE",
  "CLAUDE_CODE_SKIP_MODEL_ACCESS_MEMORY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  // Selects a profile in the user's OWN ~/.aws/config; it can't point at a
  // different config (AWS_CONFIG_FILE is never allowed).
  "AWS_PROFILE",
  // ── Claude Code on Vertex (docs/en/google-vertex-ai); per-model region
  //    overrides VERTEX_REGION_CLAUDE_* are allowed by prefix below ──
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "GCLOUD_PROJECT",
  // ── Claude Code on Microsoft Foundry (docs/en/microsoft-foundry) ──
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  // ── Codex (Codex docs: environment variables, config-advanced). NOTE: the
  //    built-in provider's base URL comes from config, not OPENAI_BASE_URL;
  //    allowed because it's harmless, not because it re-routes Codex. ──
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_OSS_BASE_URL",
  "CODEX_OSS_PORT",
  "AZURE_OPENAI_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  // ── Gemini CLI (docs/reference/configuration.md, authentication) ──
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_GENAI_API_VERSION",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // ── Network: proxy, CA trust and client certificates (an explicit
  //    operator choice: see above) ──
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "REQUESTS_CA_BUNDLE",
  "CODEX_CA_CERTIFICATE",
  "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
]);

/** Allowed by prefix: Claude Code's per-model Vertex region overrides
 *  (VERTEX_REGION_CLAUDE_3_5_HAIKU, …), about twenty documented names. */
export const PRESET_ALLOWED_KEY_PREFIXES: readonly string[] = [
  "VERTEX_REGION_CLAUDE_",
];

/**
 * Keys no preset may EVER set, not even through the operator's
 * `envPresetExtraKeys` (ADR-144): each one makes a spawned CLI run code or
 * load its config, hooks or credentials from somewhere else. These are the
 * keys the audit found the old denylist missed (V13), plus the loader and
 * runtime-injection variables that list did block.
 */
export const NEVER_PRESET_KEYS: ReadonlySet<string> = new Set([
  // Claude Code: runs a command, chooses the shell, or loads plugins/config
  // from elsewhere (code.claude.com/docs/en/env-vars)
  "CLAUDE_CODE_PROCESS_WRAPPER",
  "CLAUDE_ENV_FILE",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
  "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE",
  "CLAUDE_CODE_IDE_HOST_OVERRIDE",
  // AWS: a config that can hold credential_process (runs a command)
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  // Codex / Gemini: config, trust, sandbox command, system prompt from a file
  "CODEX_SQLITE_HOME",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
  "GEMINI_CLI_TRUST_WORKSPACE",
  "GEMINI_SANDBOX",
  "GEMINI_SANDBOX_IMAGE",
  "SANDBOX_FLAGS",
  "SANDBOX_MOUNTS",
  "SANDBOX_SET_UID_GID",
  "SEATBELT_PROFILE",
  "BUILD_SANDBOX",
  "GEMINI_SYSTEM_MD",
  "GEMINI_WRITE_SYSTEM_MD",
  "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
  // shell startup / shell choice → runs code in the agent's shell
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "SHELL",
  "PROMPT_COMMAND",
  "CLAUDE_CODE_SHELL_PREFIX",
  // a CLI's own config/settings/hooks directory
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_CLI_HOME",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "XDG_CONFIG_HOME",
  // git running commands or reading another config
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_EXEC_PATH",
  "EDITOR",
  "VISUAL",
  // runtime / dynamic-loader injection
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
  "BUN_INSPECT",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
]);

/** The operator's extra preset keys (Settings → Env presets). Read per call,
 *  so a change applies to the next spawn without a restart. */
function operatorExtraKeys(): ReadonlySet<string> {
  try {
    return new Set(getSettings().envPresetExtraKeys ?? []);
  } catch {
    return new Set();
  }
}

/** May a preset set this key? The built-in allowlist plus the operator's
 *  extra keys, and never a control-plane key or one that runs code, whatever
 *  either list says. */
export function isAllowedPresetKey(key: string): boolean {
  if (RESERVED_ENV_KEYS.has(key) || NEVER_PRESET_KEYS.has(key)) return false;
  return (
    PRESET_ALLOWED_ENV_KEYS.has(key) ||
    PRESET_ALLOWED_KEY_PREFIXES.some((p) => key.startsWith(p)) ||
    operatorExtraKeys().has(key)
  );
}

/** Why the operator can't add `key` to envPresetExtraKeys, or null if they can. */
export function extraPresetKeyProblem(key: string): string | null {
  if (!ENV_KEY_RE.test(key)) return "not a valid environment variable name";
  if (RESERVED_ENV_KEYS.has(key)) return "an autonomOS control-plane variable";
  if (NEVER_PRESET_KEYS.has(key)) {
    return "it makes a spawned CLI run code or load config from elsewhere";
  }
  return null;
}

/** The one-step fix, worded the same everywhere a key is refused. */
export function allowPresetKeyHint(): string {
  return 'If your provider\'s setup needs it, an operator can allow it in Settings → Env presets → "Extra allowed keys" (or remove it from the preset).';
}

function validateName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid preset name "${name}": must be lowercase letters, digits, and hyphens`,
    );
  }
}

function ensureDir(dir: string): void {
  // 0700: preset files hold API keys (each file is 0600 too).
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** A key a preset may not set: the caller's input is wrong (HTTP 400), not
 *  the server. Typed so every surface maps it without matching message text. */
export class PresetKeyError extends Error {
  override name = "PresetKeyError";
}

/** Validate keys for a NEW or EDITED preset: syntactically valid, not a
 *  control-plane key, and on the allowlist. */
function validateEnvKeys(keys: Iterable<string>, kind: "env" | "secret"): void {
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      throw new PresetKeyError(
        `Invalid ${kind} key "${key}": not a valid environment variable name`,
      );
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      throw new PresetKeyError(
        `Reserved ${kind} key "${key}": presets may not override autonomOS control-plane variables`,
      );
    }
    if (NEVER_PRESET_KEYS.has(key)) {
      throw new PresetKeyError(
        `Key "${key}" can't be set by a preset: it makes a spawned CLI run code or load config from elsewhere.`,
      );
    }
    if (!isAllowedPresetKey(key)) {
      throw new PresetKeyError(
        `Key "${key}" isn't a model-backend key autonomOS knows. ${allowPresetKeyHint()}`,
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
  // An edit validates only the keys it ADDS (ADR-143). The dashboard always
  // sends the full env and secretKeys, so re-checking keys already on disk
  // would refuse every edit of a preset saved before the allowlist, even a
  // description change. A kept off-list key is still never injected: the
  // spawn skips it and says so.
  if (partial.env) {
    const had = new Set(Object.keys(existing.env));
    validateEnvKeys(
      Object.keys(partial.env).filter((k) => !had.has(k)),
      "env",
    );
  }
  if (partial.secretKeys) {
    const had = new Set(existing.secretKeys);
    validateEnvKeys(
      partial.secretKeys.filter((k) => !had.has(k)),
      "secret",
    );
  }
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
  // Validate only values THIS edit sets. Keys already on disk were valid when
  // saved (a preset from before the allowlist keeps loading, ADR-143), and a
  // masked round-trip or an empty "clear" sets nothing, so re-checking those
  // would refuse every dashboard edit, including the one that removes them.
  if ("secrets" in partial && partial.secrets) {
    validateEnvKeys(
      Object.entries(partial.secrets)
        .filter(
          ([, v]) =>
            typeof v === "string" && v !== "" && !v.startsWith(SECRET_MASK),
        )
        .map(([k]) => k),
      "secret",
    );
  }
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
  /** Injectable env (env + real secrets), allowed keys only. */
  env: Record<string, string>;
  /** Declared secret keys that have no value set — spawn should refuse. */
  missingSecrets: string[];
  /** Keys the preset sets that aren't on the allowlist (a preset saved before
   *  it), skipped rather than injected. */
  skippedKeys: string[];
}

/**
 * Resolve a preset for injection at spawn. Merges non-secret env + real secret
 * values, injects ONLY allowlisted keys (a preset saved before the allowlist
 * still loads; its other keys are skipped and reported, never injected), and
 * reports declared secret keys that are still unset so the caller can refuse
 * the spawn with a clear message. Returns null if the named preset doesn't
 * exist.
 */
export function resolvePresetEnv(name: string): ResolvedPresetEnv | null {
  const raw = getEnvPresetRaw(name);
  if (!raw) return null;
  const env: Record<string, string> = {};
  const skipped = new Set<string>();
  for (const [k, v] of Object.entries(raw.env)) {
    if (isAllowedPresetKey(k)) env[k] = v;
    else skipped.add(k);
  }
  // Inject ONLY secrets whose key is currently DECLARED in secretKeys. An
  // orphaned value left on disk after a secretKey was renamed/removed must not
  // leak into the agent (it wouldn't show in the UI either) — inject-what-you-
  // declare keeps disk, UI, and process env in agreement. Also never export a
  // masked literal that reached disk by any means.
  const declared = new Set(raw.secretKeys);
  for (const [k, v] of Object.entries(raw.secrets)) {
    if (!declared.has(k) || v.startsWith(SECRET_MASK)) continue;
    if (isAllowedPresetKey(k)) env[k] = v;
    else skipped.add(k);
  }
  // A declared secret that can't be injected anyway doesn't block the spawn.
  const missingSecrets = raw.secretKeys.filter(
    (k) => isAllowedPresetKey(k) && !raw.secrets[k],
  );
  for (const k of raw.secretKeys) if (!isAllowedPresetKey(k)) skipped.add(k);
  return { env, missingSecrets, skippedKeys: [...skipped].sort() };
}

/** Why a spawn with this preset is refused: it sets keys presets may not. */
export function unknownPresetKeysError(
  presetName: string,
  keys: string[],
): string {
  return (
    `Env preset "${presetName}" sets ${keys.join(", ")}, which presets can't set: ` +
    `${keys.length === 1 ? "it isn't" : "they aren't"} on the model-backend allowlist. ` +
    `The agent was NOT started, so it can't quietly run a different model. ${allowPresetKeyHint()}`
  );
}

/**
 * Merge a preset's resolved env into `target` (mutating it), or THROW if the
 * preset doesn't exist or a declared API key is unset. This is the exact
 * spawn-time contract (ADR-067 decision 5), extracted from runtime.ts so the
 * headline behaviors — "the preset's vars reach the process env", "a keyless
 * preset refuses to spawn" and "a key off the allowlist never reaches it" —
 * are unit-testable without a PTY. Returns the keys it skipped (ADR-143), for
 * the caller to report.
 */
export function applyPresetToEnv(
  target: Record<string, string>,
  presetName: string,
): void {
  const resolved = resolvePresetEnv(presetName);
  if (!resolved) throw new Error(`Env preset "${presetName}" not found`);
  // Refuse rather than start a half-configured agent (ADR-144): a preset
  // missing one of its model-routing keys can silently run a different model.
  if (resolved.skippedKeys.length > 0) {
    throw new PresetKeyError(
      unknownPresetKeysError(presetName, resolved.skippedKeys),
    );
  }
  if (resolved.missingSecrets.length > 0) {
    throw new Error(
      `Env preset "${presetName}" is missing its API key (${resolved.missingSecrets.join(", ")}). ` +
        `Ask a human to set it in the dashboard Presets tab before spawning an agent with this preset.`,
    );
  }
  for (const [k, v] of Object.entries(resolved.env)) target[k] = v;
}

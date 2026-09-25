/**
 * Drift probe: check each installed CLI's permission options against
 * RUNTIME_PERMISSIONS — without ever starting a session.
 *
 * Why: CLIs change their permission vocabulary silently. Codex removed
 * `on-failure` (still accepted, silently coerced to on-request) and
 * `untrusted` (rejected); Claude Code renamed `default` to `manual` and added
 * `auto` / `dontAsk`. A value the CLI no longer accepts must show up here —
 * not as a spawn that fails or quietly runs with different permissions.
 *
 * How, per the table's `probe` kind:
 * - parse-time (Claude Code, Gemini): pass an invalid value and read the
 *   allowed-choices list from the parse error. The value goes BEFORE any
 *   flag that exits early — `--version` short-circuits validation in all
 *   three CLIs, so Gemini uses `--list-sessions` as its fast exit instead.
 * - config-load (Codex): `codex features list -c key=__probe__` reads only
 *   config and lists the allowed variants; each table value is then loaded
 *   for real (exit 0 = accepted). Runs with a throwaway CODEX_HOME.
 * - schema (Codex collaboration mode): `codex app-server
 *   generate-json-schema` is offline and lists the enum.
 *
 * Runs off the spawn path (at startup, and when a CLI's binary changes);
 * results are cached per binary + mtime and served by GET /api/providers.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Provider,
  RUNTIME_PERMISSIONS,
  type RuntimeAxisCheck,
  type RuntimePermissionAxis,
  type RuntimePermissionCheck,
} from "@autonomos/core";

const PROBE_TIMEOUT_MS = 15_000;
const INVALID = "__probe__";

// ── Pure parsers (tested against real CLI output) ─────────────

/** "2.1.282 (Claude Code)" / "0.46.0" / "codex-cli 0.154.0" → "x.y.z". */
export function parseVersion(output: string): string | null {
  return output.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] ?? null;
}

/** Claude Code: "… is invalid. Allowed choices are a, b, c." */
export function parseClaudeChoices(output: string): string[] | null {
  const m = output.match(/Allowed choices are ([^.\n]+)\./);
  return m
    ? m[1]
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : null;
}

/** Gemini (yargs): `Choices: "a", "b", "c"`. */
export function parseGeminiChoices(output: string): string[] | null {
  const m = output.match(/Choices:\s*(.+)/);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Codex config loader: "unknown variant `x`, expected one of `a`, `b`". */
export function parseCodexVariants(output: string): string[] | null {
  const m = output.match(/expected one of ([^\n]+)/);
  if (!m) return null;
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

/** Codex app-server schema: the enum of one definition. */
export function parseCodexSchemaEnum(
  schema: { definitions?: Record<string, unknown> },
  name: string,
): string[] | null {
  const def = schema.definitions?.[name] as
    | { enum?: string[]; oneOf?: { enum?: string[] }[] }
    | undefined;
  if (!def) return null;
  if (def.enum) return def.enum;
  const vals = (def.oneOf ?? []).flatMap((alt) => alt.enum ?? []);
  return vals.length ? vals : null;
}

/** Compare the table's values for an axis with what the CLI accepts. */
export function compareAxis(
  axis: RuntimePermissionAxis,
  accepted: string[] | null,
): RuntimeAxisCheck {
  if (!accepted)
    return { key: axis.key, accepted: null, rejected: [], unlisted: [] };
  const table = axis.values.map((v) => v.value);
  const known = new Set([
    ...table,
    ...(axis.notOffered ?? []).map((n) => n.value),
  ]);
  return {
    key: axis.key,
    accepted,
    rejected: table.filter((v) => !accepted.includes(v)),
    unlisted: accepted.filter((v) => !known.has(v)),
  };
}

// ── Running the probes ────────────────────────────────────────

interface Run {
  code: number;
  output: string;
}

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { timeout: PROBE_TIMEOUT_MS, env, encoding: "utf8", maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? -1
              : 0;
        resolve({ code, output: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
}

/** Codex accepts a config value iff loading it succeeds (exit 0). */
async function codexAccepts(
  binary: string,
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
): Promise<boolean> {
  return (
    (await run(binary, ["features", "list", "-c", `${key}=${value}`], env))
      .code === 0
  );
}

async function probeAxis(
  runtime: Provider,
  binary: string,
  axis: RuntimePermissionAxis,
  codexEnv: NodeJS.ProcessEnv,
  codexSchema: () => Promise<{ definitions?: Record<string, unknown> } | null>,
): Promise<string[] | null> {
  if (runtime === "claude-code") {
    const r = await run(binary, [`--${axis.key}`, INVALID, "--version"]);
    return parseClaudeChoices(r.output);
  }
  if (runtime === "gemini-cli") {
    const r = await run(binary, [`--${axis.key}`, INVALID, "--list-sessions"]);
    return parseGeminiChoices(r.output);
  }
  // codex
  if (axis.probe === "schema") {
    const schema = await codexSchema();
    return schema ? parseCodexSchemaEnum(schema, "ModeKind") : null;
  }
  const r = await run(
    binary,
    ["features", "list", "-c", `${axis.key}=${INVALID}`],
    codexEnv,
  );
  const variants = parseCodexVariants(r.output);
  if (!variants) return null;
  // The variant list includes removed values that still parse; a value counts
  // as accepted only if it actually loads.
  const loads = await Promise.all(
    variants.map(async (v) =>
      (await codexAccepts(binary, codexEnv, axis.key, v)) ? v : null,
    ),
  );
  return loads.filter((v): v is string => v !== null);
}

/** Probe one installed runtime. Never throws. */
export async function probeRuntime(
  runtime: Provider,
  binary: string,
): Promise<RuntimePermissionCheck> {
  const table = RUNTIME_PERMISSIONS[runtime];
  const checkedAt = new Date().toISOString();
  let codexHome: string | undefined;
  try {
    const versionRun = await run(binary, ["--version"]);
    const version = parseVersion(versionRun.output);
    codexHome =
      runtime === "codex"
        ? await mkdtemp(join(tmpdir(), "aos-codex-probe-"))
        : undefined;
    const codexEnv = {
      ...process.env,
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    };
    let schemaCache:
      | Promise<{ definitions?: Record<string, unknown> } | null>
      | undefined;
    const codexSchema = () => {
      schemaCache ??= (async () => {
        const out = await mkdtemp(join(tmpdir(), "aos-codex-schema-"));
        try {
          const r = await run(
            binary,
            ["app-server", "generate-json-schema", "--out", out],
            codexEnv,
          );
          if (r.code !== 0) return null;
          return JSON.parse(
            await readFile(
              join(out, "codex_app_server_protocol.v2.schemas.json"),
              "utf8",
            ),
          );
        } catch {
          return null;
        } finally {
          await rm(out, { recursive: true, force: true });
        }
      })();
      return schemaCache;
    };
    const axes: RuntimeAxisCheck[] = [];
    for (const axis of table.axes) {
      axes.push(
        compareAxis(
          axis,
          await probeAxis(runtime, binary, axis, codexEnv, codexSchema),
        ),
      );
    }
    return {
      version,
      checkedAt,
      versionChanged: version !== null && version !== table.verifiedOn,
      axes,
    };
  } catch (err) {
    return {
      version: null,
      checkedAt,
      versionChanged: false,
      axes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (codexHome) await rm(codexHome, { recursive: true, force: true });
  }
}

// ── Cache, keyed by binary identity ───────────────────────────

const cache = new Map<
  Provider,
  { key: string; check: Promise<RuntimePermissionCheck> }
>();

/** One line per problem, for the operator log. */
export function describeDrift(
  runtime: Provider,
  check: RuntimePermissionCheck,
): string[] {
  if (check.error)
    return [`${runtime}: permission probe failed — ${check.error}`];
  const lines: string[] = [];
  for (const a of check.axes) {
    if (a.accepted === null)
      lines.push(`${runtime} ${a.key}: couldn't read the accepted values`);
    if (a.rejected.length)
      lines.push(
        `${runtime} ${a.key}: no longer accepts ${a.rejected.join(", ")}`,
      );
    if (a.unlisted.length)
      lines.push(
        `${runtime} ${a.key}: now also accepts ${a.unlisted.join(", ")} (not offered yet)`,
      );
  }
  return lines;
}

/**
 * The cached check for a runtime, re-probing when its binary changed (an
 * upgrade replaces the file). Resolves the binary lazily so a CLI installed
 * after startup is picked up.
 */
export async function getPermissionCheck(
  runtime: Provider,
  binary: string,
): Promise<RuntimePermissionCheck> {
  let key = binary;
  try {
    key = `${binary}:${(await stat(binary)).mtimeMs}`;
  } catch {
    // unstat-able: fall back to the path alone
  }
  const hit = cache.get(runtime);
  if (hit && hit.key === key) return hit.check;
  const check = probeRuntime(runtime, binary).then((c) => {
    for (const line of describeDrift(runtime, c))
      console.warn(`[runtime-probe] ${line}`);
    if (!c.error && c.versionChanged)
      console.log(
        `[runtime-probe] ${runtime} ${c.version} (permission table verified on ${RUNTIME_PERMISSIONS[runtime].verifiedOn})`,
      );
    return c;
  });
  cache.set(runtime, { key, check });
  return check;
}

/** For tests. */
export function _resetRuntimeProbeCacheForTesting(): void {
  cache.clear();
}

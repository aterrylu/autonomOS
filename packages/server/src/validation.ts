/**
 * Request-body schemas — the ONE Zod source for every write surface
 * (consolidation PR B, ADR-078 §validation).
 *
 * Before this, each REST route hand-rolled `await c.req.json().catch(...)`
 * followed by a ladder of `typeof x === "string"` checks, while the HTTP MCP
 * server declared the same fields again as inline zod shapes in `mcp.ts`. Two
 * hand-maintained descriptions of one payload is exactly how the two surfaces
 * drifted apart. Here the raw shape is written once; MCP hands it to the SDK,
 * REST hands it to `parseBody`.
 *
 * Three rules govern what belongs in a schema and what stays in the route:
 *
 *   1. BODY SHAPE lives here — required-vs-optional, types, enums. A failure
 *      is a 400 with code "VALIDATION" and a per-field `details.issues`.
 *   2. DOMAIN validation stays in the route/store — cron parsing, channel-id
 *      format, name collisions, preset key blocklists. Those own their status
 *      codes (404/409/422) and their messages, which clients and tests read.
 *   3. Fields a surface deliberately ACCEPTS-AND-IGNORES are declared, not
 *      omitted. `z.object` strips undeclared keys silently, and silence is the
 *      defect ADR-058 removed — a declared field can be reported back to the
 *      caller as ignored (see `capabilities`).
 *
 * A few fields are typed `z.unknown()` on purpose. Those are the ones whose
 * "wrong type" handling is load-bearing behavior owned elsewhere: the spawn id
 * fields (spawnAgent's boundary guard rejects a present-but-malformed id, and
 * it must, because the HTTP MCP path reaches it without passing through here)
 * and the REST `permissionMode` (which accepts the pre-rename "default"
 * spelling and warns-and-falls-back on anything else, ADR-061). Tightening
 * those would turn a documented fallback into a 400.
 */

import { PERMISSION_MODES, type Provider } from "@autonomos/core";
import type { Context } from "hono";
import { type ZodType, z } from "zod";
import { badRequest, HttpError } from "./httpError.js";

/** Provider ids as a zod-consumable tuple. `satisfies` keeps the literals
 *  honest; `NotListed` fails the build if core gains a Provider that isn't
 *  named here (a silently-unaccepted provider would 400 every spawn using it). */
export const PROVIDER_VALUES = [
  "claude-code",
  "codex",
  "gemini-cli",
] as const satisfies readonly Provider[];
type NotListed = Exclude<Provider, (typeof PROVIDER_VALUES)[number]>;
export const _allProvidersListed: NotListed extends never ? true : false = true;

// ── Agents ──────────────────────────────────────────────────────

/**
 * Fields BOTH create-agent surfaces (MCP `create_agent`, `POST /api/agents`)
 * accept with identical meaning. The two surfaces diverge on the rest: MCP
 * names the system prompt `systemPrompt` and the fork source `forkFrom`; REST
 * names them `appendSystemPrompt` / `forkFromAgentId` and additionally accepts
 * `managerId`, `cols`, `rows`. Neither spelling is being renamed here — that is
 * PR C's job, behind compat aliases.
 */
const createAgentCommonShape = {
  workingDirectory: z
    .string()
    .describe("Absolute path to the working directory (~ allowed)"),
  name: z.string().optional().describe("Display name for the agent"),
  prompt: z
    .string()
    .optional()
    .describe("Initial task or message — what the agent starts working on"),
  template: z
    .string()
    .optional()
    .describe("Template name (e.g. 'team-lead', 'worker')"),
  manager: z.string().optional().describe("Manager agent name for org chart"),
  project: z.string().optional().describe("Project scope (e.g. 'autonomOS')"),
  provider: z
    .enum(PROVIDER_VALUES)
    .optional()
    .describe(
      "Agent runtime/CLI (default: 'claude-code'). 'codex' = OpenAI Codex CLI, 'gemini-cli' = Google Gemini CLI. Must be installed on the host.",
    ),
  envPreset: z
    .string()
    .optional()
    .describe(
      "Env preset name (see list_env_presets) — applies a model-override env (e.g. Kimi backend) to only this agent. The preset's API key must be set by a human in the dashboard first.",
    ),
};

/** MCP `create_agent`. */
export const createAgentShape = {
  ...createAgentCommonShape,
  systemPrompt: z
    .string()
    .optional()
    .describe(
      "Instructions appended to the system prompt. Defines role/goals.",
    ),
  resumeSessionId: z
    .string()
    .optional()
    .describe(
      "Session id to resume: an autonomOS agent id, OR a raw Claude Code session id — including an EXTERNAL session started via terminal `claude` (discovered in the Projects panel). External sessions are adopted into a new managed agent and resumed.",
    ),
  forkFrom: z
    .string()
    .optional()
    .describe(
      "Agent id to fork from — child inherits parent's conversation context. Mutually exclusive with resumeSessionId.",
    ),
  // Deliberately the CURRENT values only, matching mcp/tools.ts exactly.
  // Adding the legacy spelling here would publish it in the machine-readable
  // `enum` — the field a model actually trusts — teaching "default" as
  // current to every client reading this schema, and making the two MCP
  // transports advertise different vocabularies. That divergence is the bug
  // class this PR closes, not one to reintroduce.
  //
  // Backward compatibility lives where it is needed instead: autonomOS-
  // spawned agents reach create_agent through the CHANNEL server, which
  // forwards to POST /api/agents, and that route normalizes the legacy
  // spelling. This schema is read by external clients, which see the
  // current vocabulary and have no old one to hold onto.
  permissionMode: z
    .enum(PERMISSION_MODES)
    .optional()
    .describe(
      "Tool-use autonomy: 'ask' (prompt before each action), 'auto' (auto-approve edits), 'plan' (read-only; Codex falls back to 'ask'), 'bypass' (skip all prompts). Omit to keep a resumed agent's existing mode, or to take the template's / 'ask' on a fresh spawn — pass 'bypass' explicitly for full autonomy.",
    ),
};
export const CreateAgentBody = z.object(createAgentShape);

/** `POST /api/agents`. See the header note on the `z.unknown()` fields. */
export const restCreateAgentSchema = z.object({
  ...createAgentCommonShape,
  workingDirectory: z.string().min(1),
  appendSystemPrompt: z.string().optional(),
  managerId: z.string().optional(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  // Forwarded RAW to spawnAgent, which owns the present-but-malformed-id
  // rejection ("invalid session id" → 400). Coercing a mistyped id to
  // undefined here would answer a resume request with a brand-new empty agent.
  resumeAgentId: z.unknown().optional(),
  resumeSessionId: z.unknown().optional(),
  forkFromAgentId: z.unknown().optional(),
  // Normalized by `permissionModeFromStored` in the route: the pre-rename
  // "default" spelling still resolves, and an unusable value warns and falls
  // back to template/record/default rather than failing the spawn.
  permissionMode: z.unknown().optional(),
});

/** MCP `kill_agent`. Neither field is required — `name` is an accepted alias,
 *  and the handler reports the "provide one of" case itself so it can name the
 *  usage in its message. */
export const killAgentShape = {
  agent: z.string().optional().describe("Agent name or id to terminate"),
  name: z
    .string()
    .optional()
    .describe("Alias for 'agent' — agent name or id to terminate"),
};

/** MCP `set_manager`. */
export const setManagerShape = {
  agent: z
    .string()
    .optional()
    .describe("Agent name (e.g. 'Dashboard@autonomOS')"),
  name: z
    .string()
    .optional()
    .describe("Alias for 'agent' — agent name (e.g. 'Dashboard@autonomOS')"),
  manager: z
    .string()
    .optional()
    .describe("Manager agent name, or omit to remove manager"),
};

/** `POST /api/agents/:id/manager`. `managerId: null` clears the manager, so it
 *  is nullable rather than merely optional. `version` is the body-carried
 *  optimistic-concurrency token this surface uses everywhere. */
export const restSetManagerSchema = z.object({
  manager: z.string().optional(),
  managerId: z.string().nullish(),
  version: z.number().optional(),
});

/** MCP `get_org_chart`. */
export const orgChartShape = {
  includeExited: z
    .boolean()
    .optional()
    .describe("Include exited agents (default: false, only running)"),
};

// ── Templates ───────────────────────────────────────────────────

/** MCP `create_template`. */
export const createTemplateShape = {
  name: z
    .string()
    .describe("Template name (lowercase, hyphens, e.g. 'feature-worker')"),
  role: z.string().describe("Human-readable role name"),
  description: z.string().describe("Short description of the template"),
  systemPrompt: z
    .string()
    .describe("System prompt defining the agent's behavior"),
  permissionMode: z
    .enum(PERMISSION_MODES)
    .optional()
    .describe(
      "Tool-use autonomy for agents spawned from this template: 'ask' | 'auto' | 'plan' | 'bypass'. Omit to fall back to 'ask'.",
    ),
  model: z
    .string()
    .optional()
    .describe("Model override (e.g. 'opus', 'haiku')"),
  // Declared solely so it can be REPORTED as ignored. Zod strips unknown
  // keys, so without this the field vanishes silently — and agents spawned
  // before ADR-058 still hold the old schema and keep sending it. Naming it
  // deprecated here also teaches the fleet, which is the whole thesis of
  // ADR-058: tell the agent, don't hide from it. Removable once no
  // pre-ADR-058 agent is still running.
  capabilities: z
    .array(z.string())
    .optional()
    .describe(
      "DEPRECATED (ADR-058) — ignored. It never restricted anything. Constrain workers in systemPrompt instead.",
    ),
};

/**
 * `POST /api/templates`. Two fields are looser than the MCP shape ON PURPOSE:
 * this route REPORTS what it ignored (`warnings`) rather than rejecting, so a
 * bad `permissionMode` or a legacy `capabilities` of any shape must reach the
 * handler instead of 400ing at the schema.
 */
export const restCreateTemplateSchema = z.object({
  ...createTemplateShape,
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  permissionMode: z.unknown().optional(),
  capabilities: z.unknown().optional(),
});

// ── Schedules ───────────────────────────────────────────────────

/** Shared by the MCP tools keyed only by schedule name (get/delete/run). */
export const scheduleNameShape = {
  name: z.string().describe("Schedule name"),
};

/** MCP `create_schedule`. */
export const createScheduleShape = {
  name: z.string().describe("Schedule name (kebab-case)"),
  schedule: z.string().describe("Cron expression or once:ISO"),
  target: z
    .string()
    .describe(
      '"agent:<name>" — send the prompt to a running agent (its own permission mode governs the run)',
    ),
  prompt: z.string().describe("Task prompt"),
  // The three below are accepted-and-ignored leftovers of the removed
  // `isolated` target, kept so pre-removal clients still validate.
  // `workingDirectory` is optional now — it used to be required.
  // `autonomous` has no `.default(true)` any more: advertising that
  // omission grants full autonomy is what made this the one scheduled
  // path outside PermissionMode.
  workingDirectory: z
    .string()
    .optional()
    .describe("DEPRECATED — ignored (the target agent's cwd is used)"),
  description: z.string().optional().describe("Description"),
  timezone: z.string().optional().describe("IANA timezone"),
  template: z
    .string()
    .optional()
    .describe("DEPRECATED — ignored (never had an effect)"),
  autonomous: z
    .boolean()
    .optional()
    .describe(
      "DEPRECATED — ignored (autonomy is the target agent's permissionMode)",
    ),
  overlapPolicy: z.string().optional().describe("skip or allow"),
  onComplete: z
    .string()
    .optional()
    .describe("DEPRECATED — ignored (see create_schedule in mcp/tools.ts)"),
  notify: z.string().optional().describe("always, failure, or never"),
  enabled: z.boolean().optional().default(true),
};

/** MCP `update_schedule` — every config field optional, keyed by name. */
export const updateScheduleShape = {
  name: z.string().describe("Schedule name"),
  schedule: z.string().optional(),
  target: z.string().optional(),
  prompt: z.string().optional(),
  workingDirectory: z.string().optional(),
  description: z.string().optional(),
  timezone: z.string().optional(),
  template: z.string().optional(),
  autonomous: z.boolean().optional(),
  overlapPolicy: z.string().optional(),
  onComplete: z.string().optional(),
  notify: z.string().optional(),
  enabled: z.boolean().optional(),
};

/**
 * `POST /api/schedules`. The four required fields were `!x.trim()` guards; the
 * trim is part of the schema now so `"   "` still fails and the route keeps
 * receiving the trimmed value it used to compute itself. `enabled` has NO
 * default here — the route's `?? true` is the one place that decision lives.
 * Cron/target/overlap-policy validity stays with `validateScheduleInput`.
 */
export const restCreateScheduleSchema = z.object({
  ...createScheduleShape,
  name: z.string().trim().min(1),
  schedule: z.string().trim().min(1),
  target: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  enabled: z.boolean().optional(),
});

/** `PUT /api/schedules/:name` — partial merge; the name comes from the path. */
export const restUpdateScheduleSchema = z.object({
  ...updateScheduleShape,
  name: z.string().optional(),
});

/** `PUT /api/scheduler/settings`. */
export const schedulerSettingsSchema = z.object({
  maxConcurrentRuns: z
    .number()
    .int()
    .min(1, "maxConcurrentRuns must be a positive number"),
});

// ── Env presets (ADR-067) ───────────────────────────────────────
//
// The asymmetry is the point: the MCP shapes below have NO `secrets` field, so
// an agent configures everything except the credential. The REST schemas add
// it because the dashboard is where a human pastes the key. That convention is
// now backed by a store-level guard (`envPresets.ts` strips secret values
// unless the caller opts in), so a future surface that forgets the rule is
// still safe.

/** MCP `create_env_preset` — no `secrets`. */
export const createEnvPresetShape = {
  name: z.string().describe("Preset name (lowercase, digits, hyphens)"),
  description: z.string().optional(),
  provider: z.enum(PROVIDER_VALUES).optional(),
  label: z.string().optional().describe("Short label for the agent's row"),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Non-secret env vars (e.g. ANTHROPIC_BASE_URL, ANTHROPIC_MODEL)"),
  secretKeys: z
    .array(z.string())
    .optional()
    .describe(
      "Names of required secret env vars (e.g. ['ANTHROPIC_AUTH_TOKEN'])",
    ),
};

/** MCP `update_env_preset` — no `secrets`. */
export const updateEnvPresetShape = {
  name: z.string().describe("Name of the preset to update"),
  description: z.string().optional(),
  provider: z.enum(PROVIDER_VALUES).optional(),
  label: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  secretKeys: z.array(z.string()).optional(),
};

/** MCP `delete_env_preset`. */
export const envPresetNameShape = {
  name: z.string().describe("Name of the preset to delete"),
};

/** `POST /api/env-presets` — the human surface, so `secrets` is accepted. */
export const restCreateEnvPresetSchema = z.object({
  ...createEnvPresetShape,
  name: z.string().trim().min(1),
  secrets: z.record(z.string(), z.string()).optional(),
});

/** `PUT /api/env-presets/:name` — name comes from the path. */
export const restUpdateEnvPresetSchema = z.object({
  description: z.string().optional(),
  provider: z.enum(PROVIDER_VALUES).optional(),
  label: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  secretKeys: z.array(z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});

// ── Settings ────────────────────────────────────────────────────

/**
 * `PUT /api/settings`. Every field optional — this is a partial merge, and an
 * absent key means "leave it alone", never "clear it".
 *
 * `statusLine.enabled` is optional INSIDE the object because the route treats a
 * `statusLine` with no boolean `enabled` as nothing-to-do; a required `enabled`
 * would turn that no-op into a 400. Removed settings (`claudeOrgId`, the
 * `anthropic*` overrides, `terminalRenderer`) stay undeclared — zod strips
 * them, which is exactly the accept-but-discard the route documents.
 */
export const restUpdateSettingsSchema = z.object({
  claudeSessionKey: z.string().optional(),
  autoDetectClaudeAccount: z.boolean().optional(),
  /** Legacy spelling from older dashboards; mapped onto the new field. */
  autoDetectClaudeSession: z.boolean().optional(),
  autoTrust: z.boolean().optional(),
  updateCheck: z.boolean().optional(),
  channels: z.array(z.string()).optional(),
  statusLine: z.object({ enabled: z.boolean().optional() }).optional(),
  customEnvVars: z.record(z.string(), z.string()).optional(),
});

// ── The parse boundary ──────────────────────────────────────────

/** How many field errors to name in the human-readable `error` string before
 *  deferring to `details.issues` (which always carries all of them). */
const MAX_SUMMARIZED_ISSUES = 5;

/**
 * Read + validate a JSON request body, or THROW an HttpError the central
 * handler turns into the ADR-078 envelope.
 *
 * The thrown 400 keeps a readable `error` — the dashboard renders that string
 * verbatim, so "Invalid request body" alone would be a downgrade from the
 * hand-rolled `"workingDirectory is required"` it replaces — and adds
 * `details.issues` for anything parsing programmatically.
 */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Invalid JSON body", { code: "BAD_JSON" });
  }
  const result = schema.safeParse(raw);
  if (result.success) return result.data;

  const issues = result.error.issues.map((i) => ({
    path: i.path.join(".") || "(body)",
    message: i.message,
  }));
  const shown = issues
    .slice(0, MAX_SUMMARIZED_ISSUES)
    .map((i) => `${i.path}: ${i.message}`)
    .join("; ");
  const more = issues.length - MAX_SUMMARIZED_ISSUES;
  throw new HttpError(
    400,
    `Invalid request body — ${shown}${more > 0 ? ` (+${more} more)` : ""}`,
    { code: "VALIDATION", details: { issues } },
  );
}

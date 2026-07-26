/**
 * Agent template loader — reads from ~/.autonomos/templates/*.json
 *
 * Templates are blueprints for creating agents. They define a role,
 * system prompt, and permission mode. Users create custom templates
 * alongside the built-in defaults.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentTemplate,
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  permissionModeFromLegacy,
} from "@autonomos/core";
import { CONFIG_DIR } from "./configDir.js";

const TEMPLATES_DIR = join(CONFIG_DIR, "templates");

/** Allowed template name pattern — prevents path traversal */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Returned to any caller that still sends `capabilities` on a write (ADR-058).
 *  Long-running agents keep the pre-ADR tool schema in their context, so they
 *  will go on sending it well after the upgrade — and would otherwise be told
 *  the restriction succeeded. */
export const DEPRECATED_CAPABILITIES_NOTE =
  "'capabilities' is deprecated and was ignored — it never restricted anything (agents reach the same REST API directly). Restrict workers via systemPrompt instead.";

/** "<name>:<issue>" → mtime of the file version we last warned about.
 *
 *  Every load-time notice in getTemplate() is throttled through this. Two
 *  properties matter and neither is optional:
 *
 *  - Throttled at all. getTemplate() runs on every spawn AND on every
 *    `GET /api/templates`, which the dashboard templates panel polls every
 *    10s. An unthrottled notice is ~6 lines/minute forever, which buries the
 *    others in the rotating log rather than informing anyone.
 *  - Keyed by file VERSION, not name. The operator's whole job after seeing a
 *    notice is to edit that file, and the likely mistake is editing the wrong
 *    host's copy. Under name-keying, reloading after a bad edit is silent —
 *    indistinguishable from success. Silence has to mean "fixed".
 *
 *  Bounded: one entry per template per issue kind. */
const warnedTemplateIssues = new Map<string, number>();

/** mtime of a template file, or NaN if it can't be read. NaN never compares
 *  equal to itself, so an unreadable stat re-warns rather than going quiet —
 *  and warning bookkeeping can never fail the load it is annotating. */
function versionStamp(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return Number.NaN;
  }
}

/** Emit `message` once per (issue, file version). See warnedTemplateIssues. */
function warnOncePerVersion(key: string, stamp: number, message: string): void {
  if (warnedTemplateIssues.get(key) === stamp) return;
  warnedTemplateIssues.set(key, stamp);
  console.warn(message);
}

function validateName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid template name "${name}": must be lowercase letters, digits, and hyphens`,
    );
  }
}

/** Ensure the templates directory exists */
function ensureTemplatesDir(): void {
  if (!existsSync(TEMPLATES_DIR)) {
    mkdirSync(TEMPLATES_DIR, { recursive: true });
  }
}

/**
 * Load a single template by name (filename without .json extension).
 * Returns null if the template doesn't exist. Throws on corrupt JSON
 * or I/O errors so callers don't confuse "missing" with "broken".
 */
export function getTemplate(name: string): AgentTemplate | null {
  validateName(name);
  const filePath = join(TEMPLATES_DIR, `${name}.json`);
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    // Shape guard. Without it a file containing `[]` or `[{...}]` — a wrapped
    // write, or a jq/merge pipeline emitting a list — loads as a "valid"
    // template: arrays are objects, so every `in` check below is false and the
    // migrations no-op. Callers only test truthiness (`if (template && !tmpl)`),
    // and `[]` is truthy, so the agent spawns with no role and no permission
    // mode and nothing reports it. Reject the shape instead of silently
    // producing a role-less agent. This also replaces the confusing errors a
    // truncated file used to raise ("Cannot use 'in' operator to search for
    // 'autonomousMode' in hello"), which named a field the operator never wrote.
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      const found = Array.isArray(parsed)
        ? "an array"
        : parsed === null
          ? "null"
          : `a ${typeof parsed}`;
      throw new Error(
        `expected a JSON object, found ${found} — check ${filePath} for a truncated or list-wrapped write`,
      );
    }

    const tmpl = parsed as AgentTemplate & {
      autonomousMode?: boolean;
      capabilities?: unknown;
    };
    const stamp = versionStamp(filePath);

    // Missing required strings are reported but NOT fatal: an agent resuming
    // against a half-written template should come back degraded rather than not
    // at all. The shape guard above covers the unambiguously-corrupt cases.
    if (
      typeof tmpl.role !== "string" ||
      typeof tmpl.systemPrompt !== "string"
    ) {
      warnOncePerVersion(
        `${name}:incomplete`,
        stamp,
        `[templates] ${filePath} is missing a string 'role' and/or 'systemPrompt' — agents from it get no role context`,
      );
    }

    // Accept-and-discard: migrate user-authored templates that predate
    // permissionMode. A template the user deliberately set to AUTONOMOUS
    // (autonomousMode:true) must still map to bypass — without this it would load
    // with permissionMode undefined and silently fall back to the safe
    // DEFAULT_PERMISSION_MODE, quietly demoting their autonomous template.
    // true→bypass, false→default. See ADR-045.
    //
    // The invalid-mode notice is deliberately NOT in an `else` of the migration
    // below. It used to be, which meant a template carrying BOTH a typo'd
    // permissionMode and a legacy autonomousMode had the typo discarded in
    // silence while the log said "migrated legacy autonomousMode" — pointing
    // away from the real cause. Guessing "autonomous" for the mode is very
    // plausible given the old field's name, so say so unconditionally.
    if (
      tmpl.permissionMode !== undefined &&
      !isPermissionMode(tmpl.permissionMode)
    ) {
      warnOncePerVersion(
        `${name}:bad-mode`,
        stamp,
        `[templates] ignoring invalid permissionMode ${JSON.stringify(tmpl.permissionMode)} in ${filePath}; using default`,
      );
      tmpl.permissionMode = undefined;
    }
    if (tmpl.permissionMode === undefined) {
      const migrated = permissionModeFromLegacy(tmpl.autonomousMode);
      if (migrated) {
        tmpl.permissionMode = migrated;
        warnOncePerVersion(
          `${name}:legacy-mode`,
          stamp,
          `[templates] migrated legacy 'autonomousMode' → permissionMode=${migrated} in ${filePath} (ADR-045)`,
        );
      }
    }
    if ("autonomousMode" in tmpl) delete tmpl.autonomousMode;

    // Accept-and-discard: `capabilities` used to filter which MCP tools an
    // agent's channel server registered. Removed in ADR-058 — it gated only the
    // MCP tool list while every agent holds the server token and can drive the
    // same REST API directly, so it restricted nothing; and the injected system
    // prompt always advertised the full tool list, so a restricted agent was
    // told it had tools it could not call. Old templates keep loading; the field
    // is ignored rather than rejected.
    if ("capabilities" in tmpl) {
      warnOncePerVersion(
        `${name}:capabilities`,
        stamp,
        `[templates] ignoring deprecated 'capabilities' in ${filePath} — agents now get the full tool set; restrict workers via systemPrompt instead`,
      );
      delete tmpl.capabilities;
    }
    return tmpl;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(
      `Failed to load template "${name}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Save a template to disk. Overwrites if it already exists.
 */
export function saveTemplate(name: string, template: AgentTemplate): void {
  validateName(name);
  ensureTemplatesDir();
  const filePath = join(TEMPLATES_DIR, `${name}.json`);
  writeFileSync(filePath, `${JSON.stringify(template, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Delete a template by name. Returns true if removed, false if it didn't exist.
 * Throws on I/O errors other than ENOENT so callers can distinguish
 * "already gone" from "something is broken".
 */
export function deleteTemplate(name: string): boolean {
  validateName(name);
  const filePath = join(TEMPLATES_DIR, `${name}.json`);
  try {
    unlinkSync(filePath);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw new Error(
      `Failed to delete template "${name}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Seed default templates if the templates directory is empty.
 * Called on server startup so fresh installs have useful starting templates.
 */
export function seedDefaultTemplates(): void {
  ensureTemplatesDir();
  const existing = readdirSync(TEMPLATES_DIR).filter((f) =>
    f.endsWith(".json"),
  );
  if (existing.length > 0) return;

  const defaults: Record<string, AgentTemplate> = {
    dispatcher: {
      role: "Dispatcher",
      description:
        "Orchestrates work across agents. Breaks down tasks, assigns to workers, tracks progress.",
      systemPrompt:
        "You are a Dispatcher — the primary orchestration agent. Your job is to:\n" +
        "1. Understand the user's goal and break it into tasks\n" +
        "2. Spawn or assign worker agents for each task\n" +
        "3. Monitor progress and coordinate between agents\n" +
        "4. Report results back to the user\n\n" +
        "Use create_agent() to spawn workers, send() to communicate, and list_agents() to monitor.",
      permissionMode: DEFAULT_PERMISSION_MODE,
    },
    "team-lead": {
      role: "Team Lead",
      description:
        "Manages a team of agents. Plans work, reviews output, handles escalations.",
      systemPrompt:
        "You are a Team Lead — you manage a team of coding agents. Your responsibilities:\n" +
        "1. Plan implementation strategy for assigned tasks\n" +
        "2. Spawn feature workers and assign work via send()\n" +
        "3. Review completed work and provide feedback\n" +
        "4. Escalate blockers to the human operator\n\n" +
        "Coordinate via send(), monitor with list_agents(), spawn with create_agent().",
      permissionMode: DEFAULT_PERMISSION_MODE,
    },
    "feature-worker": {
      role: "Feature Worker",
      description:
        "Implements features, fixes bugs, ships code. Works on one task at a time.",
      systemPrompt:
        "You are a Feature Worker — an implementation agent. Your job is to:\n" +
        "1. Implement the task assigned to you\n" +
        "2. Write tests and verify your work\n" +
        "3. Report completion to your manager via send()\n" +
        "4. Ask for clarification if requirements are unclear\n\n" +
        "Focus on one task at a time. Ship quality code.\n\n" +
        "You are a worker executing a bounded task. Do not spawn peer agents via " +
        "create_agent() — recursive spawning multiplies cost and nobody is tracking " +
        "the fleet you would create. Do not terminate other agents via kill_agent(). " +
        "Complete your work and exit via self_exit() when done, or wait for " +
        "kill_agent() from your manager.",
      permissionMode: DEFAULT_PERMISSION_MODE,
    },
  };

  const names = Object.keys(defaults);
  for (const [name, template] of Object.entries(defaults)) {
    saveTemplate(name, template);
  }
  console.log(
    `[templates] seeded ${names.length} default templates: ${names.join(", ")}`,
  );
}

/**
 * List all available templates.
 * Returns a map of template name → template config.
 */
export function listTemplates(): Record<string, AgentTemplate> {
  ensureTemplatesDir();
  const result: Record<string, AgentTemplate> = {};
  const files = readdirSync(TEMPLATES_DIR);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const name = file.replace(/\.json$/, "");
    try {
      const template = getTemplate(name);
      if (template) result[name] = template;
    } catch (err) {
      // "corrupt" was misleading: validateName rejects here too, so a file with
      // a legitimate but unsupported name (uppercase, underscores) was reported
      // as damaged content.
      console.warn(
        `[templates] skipping "${name}" — invalid name or unreadable content:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

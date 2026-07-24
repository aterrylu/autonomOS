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

/** template name → mtime of the version we last warned about (ADR-058).
 *  Keyed by file version, not just name: the operator's whole job after seeing
 *  the notice is to edit that file, and "no warning" must mean "the field is
 *  gone", not "you were told once, three weeks ago, about a version that no
 *  longer exists". Editing the WRONG host's copy is the likely mistake here
 *  (the field is on more than one machine), and a name-keyed guard reports
 *  that as success. Bounded by template count — one entry per name. */
const warnedDeprecatedCapabilities = new Map<string, number>();

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
    const tmpl = JSON.parse(raw) as AgentTemplate & {
      autonomousMode?: boolean;
      capabilities?: unknown;
    };
    // Accept-and-discard: migrate user-authored templates that predate
    // permissionMode. A template the user deliberately set to AUTONOMOUS
    // (autonomousMode:true) must still map to bypass — without this it would load
    // with permissionMode undefined and silently fall back to the safe
    // DEFAULT_PERMISSION_MODE, quietly demoting their autonomous template.
    // true→bypass, false→default; an invalid stored mode is dropped so consumers
    // fall back to the default. See ADR-045.
    if (!isPermissionMode(tmpl.permissionMode)) {
      const migrated = permissionModeFromLegacy(tmpl.autonomousMode);
      if (migrated) {
        tmpl.permissionMode = migrated;
        console.warn(
          `[templates] migrated legacy 'autonomousMode' → permissionMode=${migrated} on template "${name}" (ADR-045)`,
        );
      } else if (tmpl.permissionMode !== undefined) {
        console.warn(
          `[templates] ignoring invalid permissionMode ${JSON.stringify(tmpl.permissionMode)} on template "${name}"; using default`,
        );
        tmpl.permissionMode = undefined;
      }
    }
    if ("autonomousMode" in tmpl) delete tmpl.autonomousMode;
    // Accept-and-discard: `capabilities` used to filter which MCP tools an
    // agent's channel server registered. Removed in ADR-058 — it gated only the
    // MCP tool list while every agent holds the server token and can drive the
    // same REST API directly, so it restricted nothing; and the injected system
    // prompt always advertised the full tool list, so a restricted agent was
    // told it had tools it could not call. Old templates keep loading; the field
    // is ignored rather than rejected. Warned once per template name because
    // getTemplate() runs on every spawn and this is informational, not a
    // behaviour change the operator must act on.
    if ("capabilities" in tmpl) {
      // NaN on a stat failure, and NaN !== NaN, so a pathological stat re-warns
      // rather than going quiet. Bookkeeping must never fail the load.
      let stamp = Number.NaN;
      try {
        stamp = statSync(filePath).mtimeMs;
      } catch {
        /* keep NaN — warn again rather than suppress */
      }
      if (warnedDeprecatedCapabilities.get(name) !== stamp) {
        warnedDeprecatedCapabilities.set(name, stamp);
        console.warn(
          `[templates] ignoring deprecated 'capabilities' in ${filePath} — agents now get the full tool set; restrict workers via systemPrompt instead`,
        );
      }
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
      console.warn(
        `Skipping corrupt template "${name}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

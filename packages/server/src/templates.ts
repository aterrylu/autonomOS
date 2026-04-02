/**
 * Agent template loader — reads from ~/.autonomos/templates/*.json
 *
 * Templates are blueprints for creating agents. They define a role,
 * system prompt, and capabilities. Users create custom templates
 * alongside the built-in defaults.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentTemplate } from "@autonomos/core";
import { CONFIG_DIR } from "./configDir.js";

const TEMPLATES_DIR = join(CONFIG_DIR, "templates");

/** Allowed template name pattern — prevents path traversal */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

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
    return JSON.parse(raw) as AgentTemplate;
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

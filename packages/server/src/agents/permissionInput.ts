/**
 * The API boundary for a caller's permission (ADR-115): `permission` is in the
 * runtime's OWN canonical values, so it only means something alongside a
 * `provider`. Shared by POST /api/agents (which the channel server forwards
 * to) and the HTTP MCP create_agent, so both surfaces answer identically.
 */

import {
  PERMISSION_RUNTIMES,
  type Provider,
  parseRuntimePermission,
  type RuntimePermission,
  validValuesMessage,
} from "@autonomos/core";

export type PermissionInputResult =
  | { ok: true; permission: RuntimePermission | undefined }
  | { ok: false; error: string };

/**
 * Parse `permission` for `provider`. Undefined input = "the caller said
 * nothing" (ok, undefined — never a default; ADR-061). An error names the
 * valid values for the provider, or for every runtime when none was given.
 */
export function parsePermissionInput(
  provider: string | undefined,
  input: unknown,
): PermissionInputResult {
  if (input === undefined) return { ok: true, permission: undefined };
  if (!PERMISSION_RUNTIMES.includes(provider as Provider)) {
    return {
      ok: false,
      error: `\`permission\` is in the runtime's own values, so \`provider\` is required with it. ${PERMISSION_RUNTIMES.map(validValuesMessage).join(". ")}.`,
    };
  }
  if (
    typeof input !== "string" &&
    (typeof input !== "object" || input === null || Array.isArray(input))
  ) {
    return { ok: false, error: validValuesMessage(provider as Provider) };
  }
  const parsed = parseRuntimePermission(
    provider as Provider,
    input as string | Record<string, unknown>,
  );
  return parsed.ok
    ? { ok: true, permission: parsed.permission }
    : { ok: false, error: parsed.error };
}

export type TemplatePermissionsResult =
  | {
      ok: true;
      permissions:
        | Partial<Record<Provider, Record<string, string>>>
        | undefined;
    }
  | { ok: false; error: string };

/**
 * Parse a template's per-runtime map (`{ runtime: canonical value }`), storing
 * each runtime's COMPLETE canonical values — so a later change to a built-in
 * default can't silently shift what the template grants.
 */
export function parseTemplatePermissions(
  input: unknown,
): TemplatePermissionsResult {
  if (input === undefined) return { ok: true, permissions: undefined };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      error:
        '`permissions` maps a runtime to its own value, e.g. {"claude-code": "acceptEdits"}',
    };
  }
  const out: Partial<Record<Provider, Record<string, string>>> = {};
  for (const [runtime, value] of Object.entries(input)) {
    const parsed = parsePermissionInput(runtime, value);
    if (!parsed.ok) return parsed;
    if (parsed.permission)
      out[runtime as Provider] = { ...parsed.permission.values };
  }
  return { ok: true, permissions: out };
}

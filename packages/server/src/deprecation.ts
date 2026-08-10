/**
 * One-release compat aliases (consolidation PR C, ADR-078 §paths).
 *
 * A renamed route keeps its OLD path mounted for one release behind this
 * middleware: requests still work, and the first hit per (method, old-path
 * pattern) logs a pointer at the new one so an operator tailing the log
 * learns about stragglers without being spammed by them. The alias — and
 * this module — are deleted in the release after the rename ships.
 */

import type { MiddlewareHandler } from "hono";

const warned = new Set<string>();

/** Wrap an aliased mount. `oldBase`/`newBase` are the mount paths, purely for
 *  the log line — routing is whatever the wrapped router does. */
export function deprecatedAlias(
  oldBase: string,
  newBase: string,
): MiddlewareHandler {
  return async (c, next) => {
    const key = `${c.req.method} ${oldBase}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(
        `[deprecated] ${c.req.method} ${c.req.path} — this path moved to ${newBase}; the ${oldBase} alias will be removed in the next release`,
      );
    }
    await next();
  };
}

/** Test hook. */
export function _resetDeprecationWarnings(): void {
  warned.clear();
}

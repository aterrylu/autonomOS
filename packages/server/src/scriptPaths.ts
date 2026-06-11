/**
 * Paths to runtime-loaded .mjs scripts — files the server passes to spawned
 * processes by PATH (statusline command, MCP channel-server subprocess), so
 * bundlers never see them as imports and never include them.
 *
 * This module MUST live at the packages/server/src ROOT, and the paths below
 * MUST be relative to it. That invariant is what makes the same constants
 * work in both runtime contexts:
 *   - tsx-from-source: import.meta.dirname === packages/server/src
 *   - bun --target=node bundle: all modules are concatenated into the entry
 *     index.js, so import.meta.dirname === the bundle dir for every module
 * build-binary.ts copies each RUNTIME_SCRIPTS entry into the bundle dir
 * preserving its relative path, so resolution and staging stay consistent
 * by construction. Adding a new runtime script? Add it to RUNTIME_SCRIPTS
 * and export its resolved path from here — nowhere else.
 */

import { resolve } from "node:path";

/** Bundle-relative paths of every runtime-loaded script. build-binary.ts
 * stages exactly this list; script-paths.test.ts asserts it stays in sync. */
export const RUNTIME_SCRIPTS = [
  "providers/statusline.mjs",
  "channel-server/dist.mjs",
] as const;

/** Statusline renderer injected into every CC session's --settings. */
export const STATUSLINE_SCRIPT = resolve(
  import.meta.dirname,
  "providers/statusline.mjs",
);

/** MCP channel-server subprocess spawned per agent session. */
export const CHANNEL_SERVER_SCRIPT = resolve(
  import.meta.dirname,
  "channel-server/dist.mjs",
);

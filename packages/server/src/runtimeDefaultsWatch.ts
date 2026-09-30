/**
 * Every change to an operator's per-runtime default permission is SAID
 * (ADR-122). These defaults decide what every agent-spawned child runs, so a
 * silent widening — to a mode that never asks — is the failure to prevent.
 *
 * Honest scope: agents run as the same OS user as the server and today can
 * obtain its token (security finding V3) or edit settings.json directly, so no
 * route check makes these defaults truly operator-only. What this module does
 * is DETECTION: a change through the API, or out-of-band (settings.json edited
 * directly), is noticed on the next read of the defaults, reported to the
 * operator in the notification bell, and logged on disk.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatPermission,
  legacyModeFor,
  PERMISSION_RUNTIMES,
  type Provider,
  type RuntimePermission,
} from "@autonomos/core";
import { getConfigDir } from "./configDir.js";
import { pushServerNotification } from "./routes/hooks.js";
import {
  type AppSettings,
  getSettings,
  runtimeDefaultPermission,
} from "./settings.js";

const NAMES: Record<Provider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

/** A value under which the agent never asks before acting. */
export function neverAsks(p: RuntimePermission): boolean {
  return legacyModeFor(p) === "bypass";
}

export interface DefaultsChange {
  at: number;
  runtime: Provider;
  from: string;
  to: string;
  neverAsks: boolean;
  source: "dashboard" | "out-of-band";
}

interface Seen {
  defaults: Record<string, string>;
  log: DefaultsChange[];
}

const LOG_CAP = 20;
let seen: Seen | undefined;

function seenFile(): string {
  return join(getConfigDir(), "runtime-defaults-seen.json");
}

function snapshot(settings: AppSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of PERMISSION_RUNTIMES)
    out[r] = formatPermission(runtimeDefaultPermission(r, settings));
  return out;
}

function load(settings: AppSettings): Seen {
  if (seen) return seen;
  try {
    const raw = JSON.parse(readFileSync(seenFile(), "utf8"));
    if (raw && typeof raw.defaults === "object" && Array.isArray(raw.log)) {
      seen = { defaults: raw.defaults, log: raw.log.slice(-LOG_CAP) };
      return seen;
    }
  } catch {
    // first run (or unreadable): baseline silently below
  }
  // First sight: today's defaults ARE the baseline — nothing changed yet.
  seen = { defaults: snapshot(settings), log: [] };
  save();
  return seen;
}

function save(): void {
  if (!seen) return;
  const file = seenFile();
  try {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(seen, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(
      `[runtime-defaults] couldn't save ${file}: ${(err as Error).message}`,
    );
  }
}

/**
 * Compare the effective defaults in `settings` with the last seen, and report
 * each runtime whose default changed. `source` says how it changed: through
 * the dashboard's PUT, or (for any other read) out-of-band.
 */
export function noteRuntimeDefaults(
  settings: AppSettings = getSettings(),
  source: DefaultsChange["source"] = "out-of-band",
): DefaultsChange[] {
  const state = load(settings);
  const now = snapshot(settings);
  const changes: DefaultsChange[] = [];
  for (const r of PERMISSION_RUNTIMES) {
    const from = state.defaults[r];
    const to = now[r];
    if (from === undefined || from === to) continue;
    const perm = runtimeDefaultPermission(r, settings);
    const change: DefaultsChange = {
      at: Date.now(),
      runtime: r,
      from,
      to,
      neverAsks: neverAsks(perm),
      source,
    };
    changes.push(change);
    const how =
      source === "out-of-band"
        ? " outside autonomOS (settings.json was edited directly)"
        : "";
    pushServerNotification(
      `${NAMES[r]}'s default permission changed${how}: ${from} → ${to}.${change.neverAsks ? " New agents on it never ask before acting." : ""}`,
    );
    console.warn(
      `[runtime-defaults] ${r} default ${from} → ${to} (${source})${change.neverAsks ? " — NEVER ASKS" : ""}`,
    );
  }
  if (
    changes.length > 0 ||
    Object.keys(state.defaults).length !== Object.keys(now).length
  ) {
    state.defaults = now;
    state.log = [...state.log, ...changes].slice(-LOG_CAP);
    save();
  }
  return changes;
}

/** The on-disk log of default changes, newest last (for Settings). */
export function runtimeDefaultsLog(
  settings: AppSettings = getSettings(),
): DefaultsChange[] {
  return [...load(settings).log];
}

/** For tests. */
export function _resetRuntimeDefaultsWatchForTesting(): void {
  seen = undefined;
}

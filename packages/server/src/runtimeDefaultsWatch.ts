/**
 * Every change to an operator's per-runtime default permission is SAID
 * (ADR-138). These defaults decide what every agent-spawned child runs, so a
 * silent widening — to a mode that never asks — is the failure to prevent.
 *
 * Honest scope: agents run as the same OS user as the server and today can
 * obtain its token (security finding V3) or edit settings.json directly, so no
 * route check makes these defaults truly operator-only. What this module does
 * is DETECTION: a change through the API, or out-of-band (settings.json edited
 * directly), is noticed on the next read of the defaults, reported to the
 * operator in the notification bell, and logged on disk.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatPermission,
  neverAsks,
  PERMISSION_RUNTIMES,
  type Provider,
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

export interface DefaultsChange {
  at: number;
  runtime: Provider;
  from: string;
  to: string;
  neverAsks: boolean;
  /** `api`: a PUT /api/settings — any token holder, not necessarily the
   *  dashboard (ADR-138); `out-of-band`: settings.json edited directly. */
  source: "api" | "out-of-band";
}

interface Seen {
  defaults: Record<string, string>;
  log: DefaultsChange[];
}

const LOG_CAP = 20;
let seen: Seen | undefined;
/** A save failure is reported once per process, not on every read. */
let saveFailureReported = false;

function seenFile(): string {
  return join(getConfigDir(), "runtime-defaults-seen.json");
}

function snapshot(settings: AppSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of PERMISSION_RUNTIMES)
    out[r] = formatPermission(runtimeDefaultPermission(r, settings));
  return out;
}

/** The seen-file's shape, or null if it isn't one we wrote. */
function parseSeen(raw: unknown): Seen | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { defaults?: unknown; log?: unknown };
  if (
    !r.defaults ||
    typeof r.defaults !== "object" ||
    Array.isArray(r.defaults) ||
    !Object.values(r.defaults).every((v) => typeof v === "string") ||
    !Array.isArray(r.log)
  )
    return null;
  const log = (r.log as unknown[]).filter(
    (e): e is DefaultsChange =>
      !!e &&
      typeof e === "object" &&
      typeof (e as DefaultsChange).runtime === "string" &&
      typeof (e as DefaultsChange).to === "string",
  );
  return {
    defaults: r.defaults as Record<string, string>,
    log: log.slice(-LOG_CAP),
  };
}

/** Name every runtime whose current default never asks — so a baseline taken
 *  on an already-permissive default is still SAID, never silent. */
function neverAsksNow(settings: AppSettings): string[] {
  return PERMISSION_RUNTIMES.filter((r) =>
    neverAsks(runtimeDefaultPermission(r, settings)),
  ).map(
    (r) =>
      `${NAMES[r]} (${formatPermission(runtimeDefaultPermission(r, settings))})`,
  );
}

function load(settings: AppSettings): Seen {
  if (seen) return seen;
  const file = seenFile();
  let reason: string | undefined;
  try {
    const parsed = parseSeen(JSON.parse(readFileSync(file, "utf8")));
    if (parsed) {
      seen = parsed;
      return seen;
    }
    reason = "it isn't in the expected shape";
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // Only a MISSING file is a first run. Anything else (corrupt JSON, EACCES,
    // a directory in the way) would re-baseline and hide a change — say so.
    if (e.code !== "ENOENT") reason = e.message;
  }
  if (reason !== undefined) {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // unreadable AND unmovable: the save below reports if it can't write
    }
  }
  // Today's defaults become the baseline — but a default that already never
  // asks is reported, so the baseline itself can't hide a widening.
  seen = { defaults: snapshot(settings), log: [] };
  const permissive = neverAsksNow(settings);
  if (reason !== undefined) {
    const msg = `Couldn't read the last-seen default permissions (${reason}); checking from the current ones.${permissive.length ? ` These never ask before acting: ${permissive.join(", ")}.` : ""}`;
    console.warn(`[runtime-defaults] ${msg}`);
    pushServerNotification(msg);
  } else if (permissive.length > 0) {
    pushServerNotification(
      `Default permissions that never ask before acting: ${permissive.join(", ")}. New agents on these runtimes that don't name a permission never ask.`,
    );
  }
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
    rmSync(`${file}.tmp`, { force: true });
    const msg = `Can't record default-permission changes to ${file}: ${(err as Error).message}. Changes are still reported while autonomOS runs, but one made while it's stopped won't be.`;
    console.warn(`[runtime-defaults] ${msg}`);
    if (!saveFailureReported) {
      saveFailureReported = true;
      pushServerNotification(msg);
    }
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
  // Called from boot, every spawn that falls back to a default, and every
  // settings read/write: a failure here must never fail any of those — it's
  // logged and reported instead (ADR-138: detection must not become an outage).
  try {
    return check(settings, source);
  } catch (err) {
    const msg = `Couldn't check the default permissions for changes: ${(err as Error).message}`;
    console.error(`[runtime-defaults] ${msg}`);
    pushServerNotification(msg);
    return [];
  }
}

function check(
  settings: AppSettings,
  source: DefaultsChange["source"],
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
        : " through the settings API";
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
  try {
    return [...load(settings).log];
  } catch {
    return []; // noteRuntimeDefaults reports the failure
  }
}

/** For tests. */
export function _resetRuntimeDefaultsWatchForTesting(): void {
  seen = undefined;
  saveFailureReported = false;
}

// Supervisor-unit drift sync — keep the installed launchd plist / systemd
// user unit matching the CURRENT template without disturbing anything the
// operator chose at install time.
//
// Why this exists: unit-template changes (e.g. ADR-077's
// StartLimitIntervalSec=0) only reach an existing install through a re-render
// of its service file, and until now the only re-render path was re-running
// the installer. `autonomos upgrade` swaps code but left the unit frozen at
// install-day vintage — so a fleet could carry a template fix in every bundle
// yet never run under it.
//
// The correctness bar (Terry's ruling): "idempotent" means NO-OP WHEN NOTHING
// CHANGED, not "always re-run the installer". Concretely:
//
//   - Install-time parameters are PRESERVED, never regenerated: the program
//     path (bundle bin or .autonomos-bin wrapper), --port/--host flags, and
//     the baked HOME/PATH environment — plus the operator-identity keys
//     (ADR-089: AUTONOMOS_TOKEN/HOST/CONFIG_DIR) — are recovered from the INSTALLED unit
//     and the fresh template is rendered around them. Re-rendering from the
//     current process env instead would flip PATH/port on every upgrade run
//     from a different shell — exactly the silent-config-drift this feature
//     exists to prevent. (bundle-mode install.sh already greps --port/--host
//     out of the old unit before its --force re-render; this is that recovery,
//     in TS, for both unit formats and both install modes.)
//   - Drift is detected by BYTE-COMPARING render(recovered params) against
//     the installed file. Identical → nothing is written, no supervisor
//     command runs. A quiet upgrade stays quiet.
//   - Unparseable units are SKIPPED with a warning, never guessed at, and a
//     sync failure never blocks the upgrade itself.
//
// Applying drift is asymmetric per platform, and the caller owns the restart:
//   - systemd re-reads units on `daemon-reload` (non-disruptive); the next
//     `restart` — which the upgrade flow performs anyway — applies ExecStart
//     changes. We daemon-reload here after writing.
//   - launchd NEVER re-reads a plist on `kickstart -k` (it restarts the
//     LOADED job definition); only bootout+bootstrap re-reads the file. So on
//     drift the caller must restart via restartServiceReloading() instead of
//     restartService() — see apply-bundle.ts.

import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { ensureUserBusEnv, type InstalledService } from "./service-control.js";
import {
  BOOT_ERROR_LOG,
  IDENTITY_ENV_KEYS,
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
} from "./service-templates.js";
import { type RunResult, run } from "./shell.js";

/** Everything install-time-variable in a unit; recovered, never regenerated. */
export type RecoveredUnitParams = {
  programArgs: string[];
  logDir: string;
  home: string;
  path: string;
  /**
   * launchd job label (darwin only; systemd units carry their identity in
   * the FILENAME, not the content). Recovered and preserved like every other
   * parameter: a heal must never re-address a unit to a different job —
   * that's how a test-labeled unit stays test-labeled after a heal, keeping
   * the label the only thing standing between a test harness and the real
   * daemon (see the test-label ADR).
   */
  label?: string;
  /** Operator-identity env (IDENTITY_ENV_KEYS) found in the unit: CARRIED. */
  extraEnv?: Record<string, string>;
  /**
   * Every other env key the unit had that the template doesn't own: NOT
   * carried (ADR-089: identity keys migrate, other overrides drop LOUDLY).
   * Names only — values may be secrets.
   */
  droppedEnvKeys?: string[];
};

/** Env keys the template itself renders (never "dropped"). */
const TEMPLATE_ENV_KEYS = new Set(["HOME", "PATH", "AUTONOMOS_SERVICE_LABEL"]);
const IDENTITY = new Set<string>(IDENTITY_ENV_KEYS);

/** Split a unit's env into what the template needs, carries, and drops. */
function classifyEnv(
  kv: Map<string, string>,
  /** Other unmanaged settings to name as dropped (no value recovered). */
  alsoDropped: readonly string[] = [],
): Pick<
  RecoveredUnitParams,
  "home" | "path" | "extraEnv" | "droppedEnvKeys"
> | null {
  const home = kv.get("HOME");
  const path = kv.get("PATH");
  if (home === undefined || path === undefined) return null;
  const extraEnv: Record<string, string> = {};
  const dropped: string[] = [...alsoDropped];
  for (const [k, v] of kv) {
    if (TEMPLATE_ENV_KEYS.has(k)) continue;
    if (IDENTITY.has(k)) extraEnv[k] = v;
    else dropped.push(k);
  }
  return {
    home,
    path,
    ...(Object.keys(extraEnv).length > 0 && { extraEnv }),
    ...(dropped.length > 0 && { droppedEnvKeys: dropped.sort() }),
  };
}

/**
 * Undo service-templates' systemdEscapePct: `%%` is a literal `%`. Any other
 * `%` is a specifier systemd EXPANDED (a hand-written `%h/.aos` ran as
 * `/home/u/.aos`), so the value we'd recover is not the value that ran:
 * null, and the sync is skipped loudly rather than freezing it as a literal.
 */
function unescapePct(s: string): string | null {
  return s.replace(/%%/g, "").includes("%") ? null : s.replace(/%%/g, "%");
}

/**
 * The assignments in one `Environment=` line, by systemd's own word rules:
 * whitespace separates assignments; "…" groups with `\` escapes; '…' groups
 * literally. Accepts both the current quoted render and legacy raw lines
 * (where `X=a b` really is "X=a" plus an ignored word — measured on
 * systemd 255 — so preserving that is preserving what actually runs).
 * Words without `=` are ignored, as systemd ignores them. null = anything we
 * can't be sure systemd read the same way: a `\` outside double quotes or any
 * escape but `\\` / `\"` (systemd C-unescapes those), a `%` specifier, or an
 * unbalanced quote.
 */
function systemdEnvAssignments(line: string): [string, string][] | null {
  const words: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\") {
        const next = line[i + 1];
        if (next !== "\\" && next !== '"') return null;
        cur += next;
        i++;
      } else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === "\\") {
      return null;
    } else if (c === " " || c === "\t") {
      if (started) words.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(cur);
  const out: [string, string][] = [];
  for (const w of words) {
    const eq = w.indexOf("=");
    if (eq <= 0) continue;
    const value = unescapePct(w.slice(eq + 1));
    if (value === null) return null;
    out.push([w.slice(0, eq), value]);
  }
  return out;
}

// Reverse of service-templates' escapeXml. Entity order matters: &amp; must
// be decoded LAST or "&amp;lt;" would double-decode into "<".
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Recover install-time parameters from a rendered LaunchAgent plist.
 * Returns null when any parameter cannot be recovered — the caller treats
 * that as "do not touch this file", never as "use defaults".
 */
export function parseLaunchAgentPlist(
  content: string,
): RecoveredUnitParams | null {
  const label = content.match(
    /<key>Label<\/key>\s*<string>([\s\S]*?)<\/string>/,
  );
  if (!label) return null;

  const pa = content.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (!pa) return null;
  const programArgs = [...pa[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
    (m) => xmlUnescape(m[1]),
  );
  if (programArgs.length === 0) return null;

  const se = content.match(
    /<key>StandardErrorPath<\/key>\s*<string>([\s\S]*?)<\/string>/,
  );
  if (!se) return null;
  const errPath = xmlUnescape(se[1]);
  const suffix = `/${BOOT_ERROR_LOG}`;
  if (!errPath.endsWith(suffix)) return null;
  const logDir = errPath.slice(0, -suffix.length);

  const envDict = content.match(
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
  );
  if (!envDict) return null;
  // Each <key> pairs with exactly ONE value element. A lazy key→<string>
  // match would run a key with a non-string value (<integer>, <true/>,
  // <data>) on into the NEXT key, losing that key and printing a value.
  const kv = new Map<string, string>();
  const nonString: string[] = [];
  const pair =
    /<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<string\/>|<(\w+)\s*\/>|<(\w+)>[\s\S]*?<\/\4>)/g;
  const body = envDict[1];
  // A numeric character reference (&#39;) isn't decoded by xmlUnescape, so
  // the value we'd carry isn't the one launchd set.
  if (body.includes("&#")) return null;
  let consumed = 0;
  for (const m of body.matchAll(pair)) {
    if (body.slice(consumed, m.index).trim() !== "") return null;
    consumed = (m.index ?? 0) + m[0].length;
    const key = xmlUnescape(m[1]);
    if (m[3] !== undefined || m[4] !== undefined) nonString.push(key);
    else kv.set(key, xmlUnescape(m[2] ?? ""));
  }
  if (body.slice(consumed).trim() !== "") return null;
  // An identity key we can't read as a string can't be carried: skip loudly.
  if (nonString.some((k) => IDENTITY.has(k) || TEMPLATE_ENV_KEYS.has(k))) {
    return null;
  }
  const env = classifyEnv(kv, nonString);
  if (!env) return null;

  return { programArgs, logDir, ...env, label: xmlUnescape(label[1]) };
}

/**
 * Undo service-templates' shellQuote for a systemd ExecStart line: plain
 * tokens split on spaces, POSIX single-quoted tokens un-quoted, `\` escaping
 * the next character outside quotes (which is how `'\''` embeds a quote).
 * Returns null on an unbalanced quote or dangling escape.
 */
function shellUnquote(line: string): string[] | null {
  const args: string[] = [];
  let cur = "";
  let started = false;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === "'") inQuote = false;
      else cur += c;
    } else if (c === "'") {
      inQuote = true;
      started = true;
    } else if (c === "\\") {
      if (i + 1 >= line.length) return null;
      cur += line[++i];
      started = true;
    } else if (c === " ") {
      if (started) {
        args.push(cur);
        cur = "";
        started = false;
      }
    } else {
      cur += c;
      started = true;
    }
  }
  if (inQuote) return null;
  if (started) args.push(cur);
  return args.length > 0 ? args : null;
}

/** Systemd-user-unit counterpart of parseLaunchAgentPlist. */
export function parseSystemdUserUnit(
  content: string,
): RecoveredUnitParams | null {
  // Forms systemd reads that our line-by-line parse can't follow — a `\`
  // line continuation, an indented or `Environment = …` directive — and
  // env directives the template never writes and we can't carry
  // (PassEnvironment / UnsetEnvironment): skip loudly, never guess.
  if (/\\$/m.test(content)) return null;
  if (/^[ \t]+\S|^(?:Environment|EnvironmentFile)[ \t]+=/m.test(content))
    return null;
  if (/^(?:PassEnvironment|UnsetEnvironment)[ \t]*=/m.test(content))
    return null;
  const exec = content.match(/^ExecStart=(.*)$/m);
  if (!exec) return null;
  const quoted = shellUnquote(exec[1]);
  if (!quoted) return null;
  const programArgs: string[] = [];
  for (const a of quoted) {
    const arg = unescapePct(a);
    if (arg === null) return null;
    programArgs.push(arg);
  }

  const se = content.match(/^StandardError=append:(.*)$/m);
  if (!se) return null;
  const errPath = unescapePct(se[1]);
  const suffix = `/${BOOT_ERROR_LOG}`;
  if (errPath === null || !errPath.endsWith(suffix)) return null;
  const logDir = errPath.slice(0, -suffix.length);

  // Every Environment= line, in order; a later assignment wins, as in systemd.
  const kv = new Map<string, string>();
  for (const m of content.matchAll(/^Environment=(.*)$/gm)) {
    // A bare `Environment=` RESETS the list in systemd; don't guess.
    if (m[1].trim() === "") return null;
    const pairs = systemdEnvAssignments(m[1]);
    if (!pairs) return null;
    for (const [k, v] of pairs) kv.set(k, v);
  }
  // The template never writes EnvironmentFile=; a hand-added one (the usual
  // home for a token) is named like any other dropped setting.
  const envFiles = /^EnvironmentFile=/m.test(content)
    ? ["EnvironmentFile="]
    : [];
  const env = classifyEnv(kv, envFiles);
  if (!env) return null;

  return { programArgs, logDir, ...env };
}

export type UnitSyncPlan =
  | { kind: "in-sync" }
  | { kind: "drift"; fresh: string; params: RecoveredUnitParams }
  | { kind: "unparseable"; reason: string };

/**
 * Pure drift decision: recover the installed unit's parameters, render the
 * current template around them, byte-compare. "drift" carries the fresh
 * content so applying is a plain write — no second render that could diverge
 * from what was compared.
 */
export function planUnitSync(
  platform: "darwin" | "linux",
  installedContent: string,
): UnitSyncPlan {
  const params =
    platform === "darwin"
      ? parseLaunchAgentPlist(installedContent)
      : parseSystemdUserUnit(installedContent);
  if (!params) {
    return {
      kind: "unparseable",
      reason:
        "could not recover install-time parameters (program args, env, log " +
        "path) from the installed unit",
    };
  }
  const fresh =
    platform === "darwin"
      ? renderLaunchAgentPlist(params)
      : renderSystemdUserUnit(params);
  if (fresh === installedContent) return { kind: "in-sync" };
  return { kind: "drift", fresh, params };
}

export type UnitSyncOutcome =
  | { kind: "in-sync" }
  // File rewritten (and daemon-reload issued on Linux). On macOS the caller
  // must apply it with a RELOADING restart — kickstart won't re-read it.
  | {
      kind: "updated";
      reloadWarning?: string;
      /** Env keys the old unit had that were NOT carried (names only). */
      droppedEnvKeys?: string[];
      /** A copy of the unit as it was, kept when keys were dropped. */
      backupFile?: string;
    }
  // Anything that stopped the sync (unreadable, unparseable, write failure).
  // Deliberately non-fatal: the upgrade proceeds under the existing unit.
  | { kind: "skipped"; reason: string };

/**
 * Sync one installed service file to the current template. IO boundary of
 * planUnitSync — `runCmd` is injectable so tests never touch systemctl.
 */
export function syncServiceUnitFor(
  svc: InstalledService,
  runCmd: (cmd: string, args: readonly string[]) => RunResult = run,
): UnitSyncOutcome {
  let installed: string;
  try {
    installed = readFileSync(svc.serviceFile, "utf-8");
  } catch (err) {
    return {
      kind: "skipped",
      reason: `could not read ${svc.serviceFile}: ${err instanceof Error ? err.message : err}`,
    };
  }

  const plan = planUnitSync(svc.platform, installed);
  if (plan.kind === "in-sync") return { kind: "in-sync" };
  if (plan.kind === "unparseable") {
    return { kind: "skipped", reason: plan.reason };
  }

  // Dropping keys? Keep the unit as it was, so the operator can copy a key
  // back (ADR-089: name what's dropped, point at the one place it survives).
  const dropped = plan.params.droppedEnvKeys ?? [];
  // Timestamped, so a later sync dropping a different key can't overwrite
  // the only copy of an earlier one. Not a unit suffix: never loaded.
  const stamp = `${svc.serviceFile}.before-sync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let backupFile = stamp;
  for (let n = 1; existsSync(backupFile); n++) backupFile = `${stamp}-${n}`;
  const droppedReport =
    dropped.length > 0 ? { droppedEnvKeys: dropped, backupFile } : {};
  if (dropped.length > 0) {
    try {
      writeFileSync(backupFile, installed, { mode: 0o600, flag: "wx" });
    } catch (err) {
      return {
        kind: "skipped",
        reason: `could not save ${backupFile} before dropping env settings (${dropped.join(", ")}): ${err instanceof Error ? err.message : err}`,
      };
    }
  }

  // Same-directory temp + rename so a crash mid-write can't leave a torn
  // unit file for the supervisor to choke on (writeInstallJson's pattern).
  const tmp = `${svc.serviceFile}.tmp`;
  try {
    writeFileSync(tmp, plan.fresh);
    // Keep the unit's own mode: a carried AUTONOMOS_TOKEN must not land in a
    // file widened from the operator's 0600 to the umask default.
    chmodSync(tmp, statSync(svc.serviceFile).mode & 0o777);
    renameSync(tmp, svc.serviceFile);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort debris cleanup
    }
    return {
      kind: "skipped",
      reason: `could not write ${svc.serviceFile}: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (svc.platform === "linux") {
    // Non-disruptive: re-reads unit definitions without touching the process.
    // ExecStart-class changes then apply at the next restart — which, in the
    // upgrade flow, is the restart that follows immediately anyway.
    ensureUserBusEnv();
    const reload = runCmd("systemctl", ["--user", "daemon-reload"]);
    if (!reload.ok) {
      return {
        kind: "updated",
        reloadWarning: reload.stderr.trim(),
        ...droppedReport,
      };
    }
  }
  return { kind: "updated", ...droppedReport };
}

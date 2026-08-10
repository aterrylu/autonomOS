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
//     the baked HOME/PATH environment are recovered from the INSTALLED unit
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

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureUserBusEnv, type InstalledService } from "./service-control.js";
import {
  BOOT_ERROR_LOG,
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
};

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

  const env = content.match(
    /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
  );
  if (!env) return null;
  const kv = new Map(
    [
      ...env[1].matchAll(
        /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g,
      ),
    ].map((m) => [xmlUnescape(m[1]), xmlUnescape(m[2])]),
  );
  const home = kv.get("HOME");
  const path = kv.get("PATH");
  if (home === undefined || path === undefined) return null;

  return { programArgs, logDir, home, path, label: xmlUnescape(label[1]) };
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
  const exec = content.match(/^ExecStart=(.*)$/m);
  if (!exec) return null;
  const programArgs = shellUnquote(exec[1]);
  if (!programArgs) return null;

  const se = content.match(/^StandardError=append:(.*)$/m);
  if (!se) return null;
  const suffix = `/${BOOT_ERROR_LOG}`;
  if (!se[1].endsWith(suffix)) return null;
  const logDir = se[1].slice(0, -suffix.length);

  // Environment= values are rendered raw (unquoted), so the value is simply
  // the rest of the line — including any spaces.
  const home = content.match(/^Environment=HOME=(.*)$/m);
  const path = content.match(/^Environment=PATH=(.*)$/m);
  if (!home || !path) return null;

  return { programArgs, logDir, home: home[1], path: path[1] };
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
  | { kind: "updated"; reloadWarning?: string }
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

  // Same-directory temp + rename so a crash mid-write can't leave a torn
  // unit file for the supervisor to choke on (writeInstallJson's pattern).
  const tmp = `${svc.serviceFile}.tmp`;
  try {
    writeFileSync(tmp, plan.fresh);
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
      return { kind: "updated", reloadWarning: reload.stderr.trim() };
    }
  }
  return { kind: "updated" };
}

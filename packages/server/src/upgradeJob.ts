// Launch the in-app upgrade OUT OF BAND (ADR-105).
//
// The daemon must never be the agent of its own restart (ADR-077 — OpenClaw's
// prod bugs: an updater running inside the supervised process dies with it).
// "Out of band" is not the same as "detached", and that distinction was
// measured, not assumed:
//
//   - systemd (forge, measured): a setsid+nohup child of the service is
//     KILLED by `systemctl --user restart` — our unit sets no KillMode, so the
//     default control-group kill takes every process in the service's cgroup,
//     detached or not. A `systemd-run --user` transient unit SURVIVED.
//   - launchd (macOS, measured): a setsid child happened to survive
//     `kickstart -k`, and so did a separately bootstrapped one-shot job.
//
// So the job always runs in its OWN supervisor scope: a transient systemd
// user unit, or a one-shot launchd job. The daemon's role is only to validate,
// write the initial status record, launch, and keep serving; the job runs the
// existing `autonomos upgrade` spine (health gate + auto-rollback, ADR-077)
// with `--status-file`, which reports progress to upgrade-status.json.
//
// A daemon NOT under a supervisor (foreground `autonomos start`) cannot be
// restarted by anything after the swap, so the in-app path refuses there and
// the dashboard tells the operator to run `autonomos upgrade` in a terminal.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";
import { upgradeStatusPath, writeUpgradeStatus } from "./upgradeStatus.js";
import { getServerVersion } from "./version.js";

type ProcLike = Pick<NodeJS.Process, "execPath" | "execArgv" | "argv" | "env">;

export type Supervisor =
  | { kind: "systemd" }
  | { kind: "launchd"; label: string }
  | { kind: "none" };

// Mirrors packages/cli/src/lib/service-templates.ts (the server can't import
// the CLI): the label install-service writes, and its systemd unit name.
const DEFAULT_SERVICE_LABEL = "com.autonomos.daemon";
const DEFAULT_SYSTEMD_UNIT = "autonomos.service";

export function expectedServiceNames(env: NodeJS.ProcessEnv = process.env): {
  launchdLabel: string;
  systemdUnit: string;
} {
  const label = env.AUTONOMOS_SERVICE_LABEL || DEFAULT_SERVICE_LABEL;
  return {
    launchdLabel: label,
    systemdUnit:
      label === DEFAULT_SERVICE_LABEL
        ? DEFAULT_SYSTEMD_UNIT
        : `${label}.service`,
  };
}

function readOwnCgroup(): string {
  try {
    return readFileSync("/proc/self/cgroup", "utf-8");
  } catch {
    return "";
  }
}

/**
 * Whether autonomOS's OWN service owns this process — not just "some
 * supervisor". The env markers alone are inherited by anything a unit/job
 * starts: a terminal that itself runs as a systemd user unit (GNOME Terminal,
 * a tmux service) hands INVOCATION_ID to a foreground `autonomos start`, and
 * the update job would then stop that daemon with nothing to restart it. So:
 *   systemd — INVOCATION_ID AND our unit in /proc/self/cgroup
 *             (verified on forge: …/app.slice/autonomos.service);
 *   launchd — XPC_SERVICE_NAME equal to OUR label (a terminal gets "0" or an
 *             application.* id; another job's label is not ours either).
 */
export function detectSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readCgroup: () => string = readOwnCgroup,
): Supervisor {
  const { launchdLabel, systemdUnit } = expectedServiceNames(env);
  if (platform === "linux" && env.INVOCATION_ID) {
    const ours = readCgroup()
      .split("\n")
      .some((line) => line.trimEnd().endsWith(`/${systemdUnit}`));
    return ours ? { kind: "systemd" } : { kind: "none" };
  }
  if (platform === "darwin" && env.XPC_SERVICE_NAME === launchdLabel) {
    return { kind: "launchd", label: launchdLabel };
  }
  return { kind: "none" };
}

/** Env the job needs to address the SAME install + service as this daemon. */
const PROPAGATED_ENV = [
  "HOME",
  "PATH",
  "AUTONOMOS_CONFIG_DIR",
  "AUTONOMOS_SERVICE_LABEL",
  "AUTONOMOS_RELEASE_API_URL",
  "AUTONOMOS_RELEASE_REPO",
  "XDG_RUNTIME_DIR",
] as const;

export type LaunchPlan = {
  argv: string[];
  env: Record<string, string>;
};

/**
 * The job's command: re-invoke THIS process's own entry point (bundle
 * index.js, or the source CLI under its tsx loader — execArgv carries it)
 * with the upgrade verb. Exported for tests.
 */
export function buildLaunchPlan(
  verbArgs: readonly string[],
  statusFile: string,
  proc: Pick<
    NodeJS.Process,
    "execPath" | "execArgv" | "argv" | "env"
  > = process,
): LaunchPlan {
  const entry = proc.argv[1];
  if (!entry) throw new Error("cannot determine this process's entry point");
  const argv = [
    proc.execPath,
    ...proc.execArgv,
    entry,
    ...verbArgs,
    `--status-file=${statusFile}`,
  ];
  const env: Record<string, string> = {};
  for (const k of PROPAGATED_ENV) {
    const v = proc.env[k];
    if (v) env[k] = v;
  }
  return { argv, env };
}

// systemd expands $VAR / $$ in transient-unit command arguments (found the
// hard way while measuring: a literal "$$" arrived as "$"). Escape every $.
function systemdEscape(arg: string): string {
  return arg.replace(/\$/g, "$$$$");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type LaunchResult = { ok: true } | { ok: false; message: string };

type Runner = (
  cmd: string,
  args: string[],
) => { status: number | null; stderr: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  return { status: r.status, stderr: r.stderr ?? String(r.error ?? "") };
};

type LaunchOpts = {
  supervisor?: Supervisor;
  run?: Runner;
  configDir?: string;
  proc?: ProcLike;
};

/** The in-app update: `autonomos upgrade --version=<target>` out of band. */
export function launchUpgradeJob(
  targetVersion: string,
  opts: LaunchOpts = {},
): LaunchResult {
  return launchJob(
    ["upgrade", `--version=${targetVersion}`],
    "upgrade",
    targetVersion,
    opts,
  );
}

/**
 * The in-app Restore: `autonomos rollback` out of band — code AND the
 * matching state snapshot, as one pair (the CLI owns the pairing).
 */
export function launchRollbackJob(
  rollbackTo: string | null,
  opts: LaunchOpts = {},
): LaunchResult {
  return launchJob(["rollback"], "rollback", rollbackTo, opts);
}

function launchJob(
  verbArgs: readonly string[],
  kind: "upgrade" | "rollback",
  targetVersion: string | null,
  opts: {
    supervisor?: Supervisor;
    run?: Runner;
    configDir?: string;
    proc?: ProcLike;
  } = {},
): LaunchResult {
  const supervisor = opts.supervisor ?? detectSupervisor();
  const run = opts.run ?? defaultRunner;
  const configDir = opts.configDir ?? getConfigDir();
  const statusFile = upgradeStatusPath(configDir);
  if (supervisor.kind === "none") {
    return {
      ok: false,
      message:
        "This daemon is not running under a service, so nothing could restart it after the update. Run `autonomos upgrade` in a terminal.",
    };
  }

  try {
    const now = new Date().toISOString();
    writeUpgradeStatus(
      {
        phase: "launching",
        kind,
        from: getServerVersion(),
        to: targetVersion,
        startedAt: now,
        updatedAt: now,
      },
      statusFile,
    );
    return startJob(supervisor, verbArgs, kind, targetVersion, statusFile, {
      run,
      configDir,
      proc: opts.proc,
    });
  } catch (err) {
    // A throw here (status/plist write, spawn) must still end on a record,
    // or the dashboard would follow a job that never started.
    return fail(
      statusFile,
      `couldn't start the ${kind === "rollback" ? "restore" : "update"} job: ${err instanceof Error ? err.message : err}`,
      kind,
      targetVersion,
    );
  }
}

function startJob(
  supervisor: Exclude<Supervisor, { kind: "none" }>,
  verbArgs: readonly string[],
  kind: "upgrade" | "rollback",
  targetVersion: string | null,
  statusFile: string,
  opts: { run: Runner; configDir: string; proc?: ProcLike },
): LaunchResult {
  const { run, configDir } = opts;
  const plan = buildLaunchPlan(verbArgs, statusFile, opts.proc);
  const stamp = Date.now();

  if (supervisor.kind === "systemd") {
    const unitBase = (
      process.env.AUTONOMOS_SERVICE_LABEL || "autonomos"
    ).replace(/[^A-Za-z0-9_.-]/g, "-");
    const args = [
      "--user",
      "--collect",
      "--quiet",
      `--unit=${unitBase}-upgrade-${stamp}`,
      ...Object.entries(plan.env).map(
        // Measured on forge: --setenv values are taken LITERALLY (only the
        // command argv gets $-expanded), so escaping them would double a `$`.
        ([k, v]) => `--setenv=${k}=${v}`,
      ),
      ...plan.argv.map(systemdEscape),
    ];
    const r = run("systemd-run", args);
    if (r.status !== 0) {
      return fail(
        statusFile,
        `systemd-run failed: ${r.stderr.trim()}`,
        kind,
        targetVersion,
      );
    }
    return { ok: true };
  }

  // launchd: a one-shot job under a label derived from the daemon's own, so a
  // test daemon (AUTONOMOS_SERVICE_LABEL=…test) launches a test-labelled job.
  const label = `${supervisor.label}.upgrade`;
  const logDir = join(configDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const plistPath = join(configDir, "upgrade-job.plist");
  const envXml = Object.entries(plan.env)
    .map(
      ([k, v]) => `<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`,
    )
    .join("");
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyLists-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array>${plan.argv.map((a) => `<string>${xmlEscape(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${envXml}</dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xmlEscape(join(logDir, "upgrade-job.log"))}</string>
<key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "upgrade-job.log"))}</string>
</dict></plist>
`,
  );
  const uid = process.getuid?.() ?? 0;
  // A previous run's job stays loaded (not running) after it exits — clear it
  // so bootstrap doesn't refuse with "already loaded". Failure = not loaded.
  run("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const r = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (r.status !== 0) {
    return fail(
      statusFile,
      `launchctl bootstrap failed: ${r.stderr.trim()}`,
      kind,
      targetVersion,
    );
  }
  return { ok: true };
}

function fail(
  statusFile: string,
  message: string,
  kind: "upgrade" | "rollback",
  to: string | null,
): LaunchResult {
  const now = new Date().toISOString();
  try {
    writeUpgradeStatus(
      {
        phase: "failed",
        kind,
        from: getServerVersion(),
        to,
        message,
        startedAt: now,
        updatedAt: now,
      },
      statusFile,
    );
  } catch (err) {
    // The caller still gets the failure in its HTTP response.
    console.error(
      `[upgrade] could not record the launch failure: ${err instanceof Error ? err.message : err}`,
    );
  }
  return { ok: false, message };
}

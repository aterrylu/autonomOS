// `autonomos install-service` — install the OS-native daemon supervisor.
//
// Writes a launchd plist (mac) or systemd-user unit (linux) that runs
// `autonomos start` and restarts on failure. Survives logout/reboot.
//
// Flags:
//   --prefix=DIR     Write under DIR instead of $HOME (hermetic-test escape hatch)
//   --no-activate    Just write the file; don't run launchctl/systemctl
//   --bin=PATH       Override the auto-detected program path
//   --force          Re-install even if file already exists
//   --open           After the daemon comes up, open the dashboard in a browser
//
// After activation it polls until the daemon is responsive (a real smoke test,
// not a guess) and prints the dashboard URL + token — see lib/post-install.ts.
//
// Exit codes:
//   0 — installed and activated (or written with --no-activate)
//   1 — failure (file write, launchctl/systemctl, etc.)
//   2 — unsupported platform
//   3 — activated, but the daemon didn't become responsive in time (so a piped
//       `curl install.sh` reports the failure instead of a false success)

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { detectPm2Install } from "../lib/pm2.js";
import { verifyAndReportInstall } from "../lib/post-install.js";
import {
  defaultPrefix,
  detectProgramArgs,
  getServicePaths,
} from "../lib/service-paths.js";
import {
  renderLaunchAgentPlist,
  renderSystemdUserUnit,
} from "../lib/service-templates.js";
import { runIgnoring, runOrThrow } from "../lib/shell.js";

type InstallFlags = {
  prefix: string;
  noActivate: boolean;
  bin: string | undefined;
  force: boolean;
  port: number | undefined;
  open: boolean;
};

function parseFlags(argv: readonly string[]): InstallFlags {
  let prefix = defaultPrefix();
  let noActivate = false;
  let bin: string | undefined;
  let force = false;
  let port: number | undefined;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-activate") noActivate = true;
    else if (a === "--open") open = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--prefix=")) prefix = a.slice("--prefix=".length);
    else if (a === "--prefix") prefix = argv[++i] ?? defaultPrefix();
    else if (a.startsWith("--bin=")) bin = a.slice("--bin=".length);
    else if (a === "--bin") bin = argv[++i];
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--port") port = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 0 || port > 65535)
  ) {
    throw new Error(`Invalid --port value: must be 0-65535`);
  }
  return { prefix, noActivate, bin, force, port, open };
}

export async function runInstallServiceCommand(
  argv: readonly string[],
): Promise<number> {
  let flags: InstallFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 64;
  }

  let paths: ReturnType<typeof getServicePaths>;
  try {
    paths = getServicePaths(flags.prefix);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  // Refuse to install on top of a running server (ADR-029 mutual exclusion).
  // The pid file is the source of truth — if a live owner exists, the user
  // must stop it first before LaunchAgent takes over.
  if (!flags.force) {
    try {
      const { readPidFile, isPidAlive, isPortResponsive } = await import(
        "@autonomos/server/pid-file.js"
      );
      const owner = readPidFile();
      if (
        owner &&
        isPidAlive(owner.pid) &&
        (await isPortResponsive(owner.port))
      ) {
        console.error(
          `Another autonomos-server is already running:\n` +
            `  pid:     ${owner.pid}\n` +
            `  port:    ${owner.port}\n` +
            `  version: ${owner.version}\n\n` +
            `If this is autonomOS Desktop's Built-in server, quit the\n` +
            `Desktop app first, then re-run install-service.\n\n` +
            `Otherwise stop the server with \`autonomos stop\`, then\n` +
            `re-run install-service.\n\n` +
            `Or use --force to install anyway (risks port collision).`,
        );
        return 1;
      }
    } catch {
      // Best-effort — if pid-file APIs aren't available, fall through.
    }
  }

  // Refuse to install on top of a pm2-managed autonomos — would race on port
  // 3100 and confuse the user. Direct them to migrate-from-pm2 explicitly.
  if (!flags.force) {
    const pm2 = detectPm2Install();
    if (pm2.managed) {
      console.error(
        `Detected pm2-managed autonomos (${pm2.processes.length} process(es)).\n` +
          `Run \`autonomos migrate-from-pm2\` to switch supervisors cleanly,\n` +
          `or re-run with --force to install anyway (NOT recommended — will\n` +
          `cause port collision unless you stop pm2 first).`,
      );
      return 1;
    }
  }

  if (existsSync(paths.serviceFile) && !flags.force) {
    console.error(
      `Service file already exists at ${paths.serviceFile}.\n` +
        `Use --force to overwrite, or run \`autonomos uninstall-service\` first.`,
    );
    return 1;
  }

  // Program-args either auto-detected or overridden via --bin. Append --port
  // when explicitly requested (preserves the port on pm2 migrations).
  const baseArgs = flags.bin ? [flags.bin, "start"] : detectProgramArgs();
  const programArgs =
    flags.port !== undefined ? [...baseArgs, `--port=${flags.port}`] : baseArgs;

  mkdirSync(paths.serviceDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });

  if (process.platform === "darwin") {
    const plist = renderLaunchAgentPlist({
      programArgs,
      logDir: paths.logDir,
      home: homedir(),
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    });
    writeFileSync(paths.serviceFile, plist);
    console.log(`✓ Wrote ${paths.serviceFile}`);

    if (!flags.noActivate) {
      // Unload first (idempotent — ignores error if not loaded)
      runIgnoring("launchctl", ["unload", paths.serviceFile]);
      try {
        runOrThrow("launchctl", ["load", paths.serviceFile]);
      } catch (err) {
        console.error(
          err instanceof Error ? err.message : err,
          "\n(LaunchAgent file is written; you can load it manually with " +
            `\`launchctl load ${paths.serviceFile}\`)`,
        );
        return 1;
      }
      console.log("✓ Loaded via launchctl");
      console.log(`  Logs: ${paths.logDir}/autonomos.log`);
      if (!(await verifyAndReportInstall({ open: flags.open }))) return 3;
    }
    return 0;
  }

  if (process.platform === "linux") {
    const unit = renderSystemdUserUnit({
      programArgs,
      logDir: paths.logDir,
      home: homedir(),
      path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    });
    writeFileSync(paths.serviceFile, unit);
    console.log(`✓ Wrote ${paths.serviceFile}`);

    if (!flags.noActivate) {
      // Enable lingering so the user service survives logout
      runIgnoring("loginctl", ["enable-linger", userInfo().username]);
      try {
        runOrThrow("systemctl", ["--user", "daemon-reload"]);
        runOrThrow("systemctl", [
          "--user",
          "enable",
          "--now",
          "autonomos.service",
        ]);
      } catch (err) {
        console.error(
          err instanceof Error ? err.message : err,
          "\n(Unit file is written; you can enable it manually with " +
            "`systemctl --user enable --now autonomos.service`)",
        );
        return 1;
      }
      console.log("✓ Enabled and started via systemctl --user");
      console.log(`  Logs: ${paths.logDir}/autonomos.log`);
      if (!(await verifyAndReportInstall({ open: flags.open }))) return 3;
    }
    return 0;
  }

  // Should be unreachable because getServicePaths threw above on unsupported
  // platforms, but TypeScript doesn't know that.
  return 2;
}

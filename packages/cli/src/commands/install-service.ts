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
//
// Exit codes:
//   0 — installed and activated (or written with --no-activate)
//   1 — failure (file write, launchctl/systemctl, etc.)
//   2 — unsupported platform

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { detectPm2Install } from "../lib/pm2.js";
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
};

function parseFlags(argv: readonly string[]): InstallFlags {
  let prefix = defaultPrefix();
  let noActivate = false;
  let bin: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-activate") noActivate = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--prefix=")) prefix = a.slice("--prefix=".length);
    else if (a === "--prefix") prefix = argv[++i] ?? defaultPrefix();
    else if (a.startsWith("--bin=")) bin = a.slice("--bin=".length);
    else if (a === "--bin") bin = argv[++i];
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { prefix, noActivate, bin, force };
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

  // Program-args either auto-detected or overridden via --bin
  const programArgs = flags.bin ? [flags.bin, "start"] : detectProgramArgs();

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
      console.log("✓ Loaded via launchctl — daemon should be running shortly");
      console.log(`  Logs: ${paths.logDir}/autonomos.log`);
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
    }
    return 0;
  }

  // Should be unreachable because getServicePaths threw above on unsupported
  // platforms, but TypeScript doesn't know that.
  return 2;
}

#!/usr/bin/env node
// `autonomos` CLI entry point.
//
// Subcommand dispatcher. Recognized subcommands:
//   start                  Run the server in the foreground
//   stop                   Gracefully stop a running daemon
//   restart                Restart the installed service
//   status                 Print running daemon's state
//   logs                   Tail the server log
//   install-service / uninstall-service / upgrade / migrate-from-pm2
//   --help, -h, help       Print usage
//
// If the first argv looks like a flag (--port=N) instead of a subcommand,
// treat it as an implicit `start` — preserves the Phase 1A.1 invocation
// pattern `node bundle.js --port=N`.

// MUST be the FIRST import — sets NAPI_RS_NATIVE_LIBRARY_PATH for the universal2
// bundle before any module transitively loads impit's native binding. See file.
import "./napi-universal-binding.js";
import { getServerVersion } from "@autonomos/server/version.js";
import { runInstallServiceCommand } from "./commands/install-service.js";
import { runLogsCommand } from "./commands/logs.js";
import { runMigrateFromPm2Command } from "./commands/migrate-from-pm2.js";
import { runRestartCommand } from "./commands/restart.js";
import { runRollbackCommand } from "./commands/rollback.js";
import { runStartCommand } from "./commands/start.js";
import { runStatusCommand } from "./commands/status.js";
import { runStopCommand } from "./commands/stop.js";
import { runUninstallServiceCommand } from "./commands/uninstall-service.js";
import { runUpgradeCommand } from "./commands/upgrade.js";

const USAGE = `Usage: autonomos <command> [options]

Commands:
  start [options]      Run the server in the foreground (default if no command)
                       Options: --port=N, --host=H (default 127.0.0.1 —
                       loopback only; --host=0.0.0.0 exposes to the network)
  stop                 Gracefully stop a running daemon (SIGTERM)
  restart              Restart the installed service (launchctl / systemctl)
  status               Print running daemon's state
  logs                 Tail the server log ($configDir/logs/autonomos.log)
                       Options: -f/--follow, -n/--lines=N (default 50)
  install-service      Install OS-native supervisor (launchd / systemd-user)
                       Options: --prefix=DIR, --no-activate, --bin=PATH, --force,
                       --open, --port=N, --host=H (bakes the bind into the
                       service file; prefer AUTONOMOS_HOST in .env to persist it)
  uninstall-service    Stop daemon and remove the service file
                       Options: --prefix=DIR
  upgrade [version]    Fetch a release (default: latest), verify, atomic swap,
    (alias: update)    restart, verify the new version boots — auto-rolls back
                       if it doesn't. Options: --version=X.Y.Z (pin/downgrade)
  rollback             Swap back to the version the last upgrade replaced
  migrate-from-pm2     Stop pm2's autonomos process and install the new
                       OS-native supervisor (one-shot migration for old users)
  version, --version   Print the installed version
  help, --help, -h     Print this message

Examples:
  autonomos                         # start the server with defaults
  autonomos start --port=3100       # start on a specific port
  autonomos status                  # check if a daemon is running
  autonomos logs -f                 # follow the server log
  autonomos restart                 # restart the installed service
  autonomos stop                    # stop the running daemon
  autonomos install-service         # install as a persistent service
  autonomos uninstall-service       # remove the service installation
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  // No args, or first arg is a flag → implicit start
  if (first === undefined || first.startsWith("-")) {
    if (first === "--help" || first === "-h") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (first === "--version" || first === "-v") {
      process.stdout.write(`${getServerVersion()}\n`);
      return 0;
    }
    await runStartCommand(argv);
    return 0;
  }

  switch (first) {
    case "start":
      await runStartCommand(argv.slice(1));
      return 0;
    case "stop":
      return await runStopCommand();
    case "restart":
      return await runRestartCommand();
    case "status":
      return await runStatusCommand();
    case "logs":
      return await runLogsCommand(argv.slice(1));
    case "install-service":
      return await runInstallServiceCommand(argv.slice(1));
    case "uninstall-service":
      return await runUninstallServiceCommand(argv.slice(1));
    case "upgrade":
    case "update":
      return await runUpgradeCommand(argv.slice(1));
    case "rollback":
      return await runRollbackCommand();
    case "migrate-from-pm2":
      return await runMigrateFromPm2Command(argv.slice(1));
    case "version":
      process.stdout.write(`${getServerVersion()}\n`);
      return 0;
    case "help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${first}\n\n${USAGE}`);
      return 64; // EX_USAGE
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });

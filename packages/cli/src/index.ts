#!/usr/bin/env node
// `autonomos` CLI entry point.
//
// Subcommand dispatcher. Recognized subcommands:
//   start                  Run the server in the foreground
//   stop                   Gracefully stop a running daemon
//   status                 Print running daemon's state
//   --help, -h, help       Print usage
//
// If the first argv looks like a flag (--port=N) instead of a subcommand,
// treat it as an implicit `start` — preserves the Phase 1A.1 invocation
// pattern `node bundle.js --port=N --embedded`.

import { runInstallServiceCommand } from "./commands/install-service.js";
import { runMigrateFromPm2Command } from "./commands/migrate-from-pm2.js";
import { runStartCommand } from "./commands/start.js";
import { runStatusCommand } from "./commands/status.js";
import { runStopCommand } from "./commands/stop.js";
import { runUninstallServiceCommand } from "./commands/uninstall-service.js";
import { runUpgradeCommand } from "./commands/upgrade.js";

const USAGE = `Usage: autonomos <command> [options]

Commands:
  start [options]      Run the server in the foreground (default if no command)
                       Options: --port=N, --embedded
  stop                 Gracefully stop a running daemon (SIGTERM)
  status               Print running daemon's state
  install-service      Install OS-native supervisor (launchd / systemd-user)
                       Options: --prefix=DIR, --no-activate, --bin=PATH, --force
  uninstall-service    Stop daemon and remove the service file
                       Options: --prefix=DIR
  upgrade              Fetch latest release, verify, atomic swap, restart daemon
  migrate-from-pm2     Stop pm2's autonomos process and install the new
                       OS-native supervisor (one-shot migration for old users)
  help, --help, -h     Print this message

Examples:
  autonomos                         # start the server with defaults
  autonomos start --port=3100       # start on a specific port
  autonomos --embedded --port=0     # embedded mode (Electron child)
  autonomos status                  # check if a daemon is running
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
    await runStartCommand(argv);
    return 0;
  }

  switch (first) {
    case "start":
      await runStartCommand(argv.slice(1));
      return 0;
    case "stop":
      return await runStopCommand();
    case "status":
      return await runStatusCommand();
    case "install-service":
      return await runInstallServiceCommand(argv.slice(1));
    case "uninstall-service":
      return await runUninstallServiceCommand(argv.slice(1));
    case "upgrade":
      return await runUpgradeCommand();
    case "migrate-from-pm2":
      return await runMigrateFromPm2Command(argv.slice(1));
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

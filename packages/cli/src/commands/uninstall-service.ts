// `autonomos uninstall-service` — undo install-service.
//
// Stops the daemon (if running under launchctl/systemctl) and removes the
// service file. Does NOT touch the binary itself.
//
// Flags:
//   --prefix=DIR     Same as install-service — for hermetic-test verification
//
// Exit codes:
//   0 — uninstalled (or wasn't installed)
//   1 — failure removing the file
//   2 — unsupported platform

import { existsSync, unlinkSync } from "node:fs";
import { defaultPrefix, getServicePaths } from "../lib/service-paths.js";
import { runIgnoring } from "../lib/shell.js";

function parseFlags(argv: readonly string[]): { prefix: string } {
  let prefix = defaultPrefix();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--prefix=")) prefix = a.slice("--prefix=".length);
    else if (a === "--prefix") prefix = argv[++i] ?? defaultPrefix();
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { prefix };
}

export async function runUninstallServiceCommand(
  argv: readonly string[],
): Promise<number> {
  let flags: { prefix: string };
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

  if (!existsSync(paths.serviceFile)) {
    console.log("No service file installed — nothing to remove.");
    return 0;
  }

  // Stop + remove from supervisor first; if those fail it's not fatal,
  // we still want to remove the file.
  if (process.platform === "darwin") {
    runIgnoring("launchctl", ["unload", paths.serviceFile]);
  } else if (process.platform === "linux") {
    runIgnoring("systemctl", [
      "--user",
      "disable",
      "--now",
      "autonomos.service",
    ]);
  }

  try {
    unlinkSync(paths.serviceFile);
  } catch (err) {
    console.error(
      `Failed to remove ${paths.serviceFile}: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }

  console.log(`✓ Removed ${paths.serviceFile}`);
  return 0;
}

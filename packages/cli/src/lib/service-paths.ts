// Compute the paths and program-args used by install-service / uninstall-service.
//
// All paths can be redirected to a test prefix via --prefix=DIR, which lets
// the hermetic test harness verify install logic without touching the user's
// real ~/Library/LaunchAgents/ or ~/.config/systemd/user/.

import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "@autonomos/server/configDir.js";
import { launchAgentFilename, systemdUnitName } from "./service-templates.js";

export type ServicePaths = {
  /** Where the plist or unit file is written */
  serviceFile: string;
  /** Parent directory of serviceFile (mkdir -p target) */
  serviceDir: string;
  /** Where the daemon writes its stdout/stderr logs */
  logDir: string;
};

export function getServicePaths(prefix: string): ServicePaths {
  const logDir = join(getConfigDir(), "logs");
  if (process.platform === "darwin") {
    const serviceDir = join(prefix, "Library/LaunchAgents");
    return {
      serviceDir,
      serviceFile: join(serviceDir, launchAgentFilename()),
      logDir,
    };
  }
  if (process.platform === "linux") {
    const serviceDir = join(prefix, ".config/systemd/user");
    return {
      serviceDir,
      serviceFile: join(serviceDir, systemdUnitName()),
      logDir,
    };
  }
  throw new Error(
    `Unsupported platform: ${process.platform} ` +
      `(install-service supports darwin and linux; ` +
      `windows is deferred to a future phase)`,
  );
}

/**
 * Determine the program-args that the service file should invoke.
 *
 * For real installed binaries (single executable in PATH):
 *   process.argv[0] === process.argv[1] (the binary IS the entry point)
 *   → return ["/path/to/binary", "start"]
 *
 * For node + script invocations (dev with tsx, or the bundled .js delivery):
 *   process.argv[0] is "node" (or similar runtime), argv[1] is the script
 *   → return ["node", "/path/to/script", "start"]
 *
 * Callers can override this via the --bin flag if the auto-detection picks
 * something undesired (e.g., during testing).
 */
export function detectProgramArgs(): string[] {
  const exec = process.argv[0];
  const script = process.argv[1];
  if (!exec) throw new Error("process.argv[0] is missing");
  if (!script || exec === script) return [exec, "start"];
  return [exec, script, "start"];
}

export function defaultPrefix(): string {
  return homedir();
}

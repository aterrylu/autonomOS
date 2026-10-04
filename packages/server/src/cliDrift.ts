/**
 * Check the INSTALLED agent CLIs' permission options against the
 * RUNTIME_PERMISSIONS table, for CI: the same no-session probe the server runs
 * at boot (runtimeProbe.ts), but as a verdict. Any drift — a value the CLI no
 * longer accepts (dropped or renamed), a value it accepts that the table
 * doesn't list, unreadable choices, or a failed probe — is a problem, named by
 * runtime, option and value, so a CLI update that changes an option fails
 * loudly instead of surfacing as a broken spawn.
 */

import { execFileSync } from "node:child_process";
import { type Provider, RUNTIME_PERMISSIONS } from "@autonomos/core";
import { describeDrift, probeRuntime } from "./runtimeProbe.js";

/** The command each runtime installs. */
export const CLI_COMMANDS: Record<Provider, string> = {
  "claude-code": "claude",
  codex: "codex",
  "gemini-cli": "gemini",
};

export interface CliDriftResult {
  /** A line per runtime: what was checked, at which version. */
  checked: string[];
  /** A line per problem; empty = no drift. */
  problems: string[];
}

function onPath(command: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const out = execFileSync("sh", ["-c", `command -v ${command}`], {
      env,
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Probe each runtime's installed CLI. A runtime in `required` that isn't on
 * PATH is a problem; any other missing one is skipped (and said).
 */
export async function checkInstalledClis(opts: {
  runtimes?: readonly Provider[];
  required?: readonly Provider[];
  env?: NodeJS.ProcessEnv;
}): Promise<CliDriftResult> {
  const env = opts.env ?? process.env;
  const runtimes =
    opts.runtimes ?? (Object.keys(RUNTIME_PERMISSIONS) as Provider[]);
  const checked: string[] = [];
  const problems: string[] = [];
  for (const runtime of runtimes) {
    const bin = onPath(CLI_COMMANDS[runtime], env);
    if (!bin) {
      if (opts.required?.includes(runtime))
        problems.push(
          `${runtime}: \`${CLI_COMMANDS[runtime]}\` isn't installed`,
        );
      else checked.push(`${runtime}: not installed, skipped`);
      continue;
    }
    const check = await probeRuntime(runtime, bin);
    checked.push(
      `${runtime}: ${check.version ?? "version unknown"} (table verified on ${RUNTIME_PERMISSIONS[runtime].verifiedOn})`,
    );
    problems.push(...describeDrift(runtime, check));
  }
  return { checked, problems };
}

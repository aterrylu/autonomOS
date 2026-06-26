// Tiny wrapper around node:child_process for shell-style command execution.
// Used by the service-install / uninstall commands to invoke launchctl and
// systemctl. Designed to surface clear errors without leaking child stderr
// into stdout where the user would have to dig for it.

import { spawnSync } from "node:child_process";

export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function run(cmd: string, args: readonly string[]): RunResult {
  const result = spawnSync(cmd, args, { encoding: "utf-8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? -1,
  };
}

/**
 * Run a command and throw a descriptive Error if it fails.
 * Useful when a step is load-bearing for install/uninstall correctness.
 */
export function runOrThrow(cmd: string, args: readonly string[]): RunResult {
  const result = run(cmd, args);
  if (!result.ok) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${result.exitCode})\n  stderr: ${result.stderr.trim()}`,
    );
  }
  return result;
}

/** Like run() but ignores failure. Useful for idempotent cleanup. */
export function runIgnoring(cmd: string, args: readonly string[]): RunResult {
  return run(cmd, args);
}

// `autonomos logs` — tail the server-owned rotating log.
//
// Replaces `pm2 logs autonomos`. The daemon tees stdout+stderr into a rotating
// $configDir/logs/autonomos.log (server/src/logger.ts); this command tails it.
// We shell out to `tail` (present on macOS + Linux) so `--follow` streams live
// without us reimplementing inotify/kqueue.
//
// Flags:
//   -f, --follow      Stream new lines as they arrive (blocks until Ctrl-C)
//   -n, --lines=N     Show the last N lines (default 50)
//
// Exit codes:
//   0 — printed (or follow exited cleanly)
//   1 — no log file yet / tail failed
//   64 — bad flags (EX_USAGE)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "@autonomos/server/configDir.js";

type LogsFlags = { follow: boolean; lines: number };

function parseFlags(argv: readonly string[]): LogsFlags {
  let follow = false;
  let lines = 50;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--follow") follow = true;
    else if (a === "-n" || a === "--lines") lines = Number(argv[++i]);
    else if (a.startsWith("--lines="))
      lines = Number(a.slice("--lines=".length));
    else if (a.startsWith("-n")) lines = Number(a.slice(2));
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!Number.isInteger(lines) || lines < 0) {
    throw new Error(`Invalid --lines value: must be a non-negative integer`);
  }
  return { follow, lines };
}

export async function runLogsCommand(argv: readonly string[]): Promise<number> {
  let flags: LogsFlags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 64;
  }

  const logDir = join(getConfigDir(), "logs");
  const logFile = join(logDir, "autonomos.log");

  if (!existsSync(logFile)) {
    console.error(
      `No log file at ${logFile}.\n` +
        `The server writes it once it has started — check \`autonomos status\`.\n` +
        `Early-boot crashes (before logging attaches) land in ` +
        `${join(logDir, "autonomos.boot.error.log")}.`,
    );
    return 1;
  }

  const tailArgs = ["-n", String(flags.lines)];
  if (flags.follow) tailArgs.push("-f");
  tailArgs.push(logFile);

  return await new Promise<number>((resolve) => {
    const child = spawn("tail", tailArgs, { stdio: "inherit" });
    // Forward Ctrl-C to the child so `logs -f` stops promptly.
    const onSigint = (): void => {
      child.kill("SIGINT");
    };
    process.on("SIGINT", onSigint);
    child.on("error", (err) => {
      process.off("SIGINT", onSigint);
      console.error(`Failed to run tail: ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => {
      process.off("SIGINT", onSigint);
      resolve(code ?? 0);
    });
  });
}

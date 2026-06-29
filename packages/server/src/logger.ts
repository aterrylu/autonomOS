// Server-owned rotating log file.
//
// WHY this exists: under OS-native supervision (launchd `StandardOutPath`,
// systemd `StandardOutput=append:`) the *supervisor* holds the log file open
// and appends forever — there is no built-in rotation, so the file grows
// unbounded (pm2 had a logrotate module; launchd/systemd-user do not). We can't
// rotate a file the supervisor holds an fd to (it would keep writing to the
// unlinked inode), and we can't point both the supervisor and a rotating logger
// at the same path (two writers corrupt it).
//
// The fix: the SERVER owns its log. `initFileLogging()` tees every stdout/stderr
// write into a rotating `~/.autonomos/logs/autonomos.log` (stdout + stderr
// merged, like the old pm2 `merge_logs: true`), keeping the newest N segments.
// It echoes to the original sink ASYMMETRICALLY (see patch()): stdout ALWAYS —
// it carries the `AUTONOMOS_READY` IPC + `--print-url`, and its supervisor sink
// is /dev/null so echoing is free — while stderr echoes only on a TTY. Under
// the service, stderr's supervisor sink is the boot.error.log FILE, so echoing
// every runtime console.error there would regrow the unbounded log this design
// exists to kill; instead the tee captures stderr in the rotating file and the
// supervisor backstop only holds the pre-attach window. See service-templates.ts.
//
// `autonomos logs` (cli/commands/logs.ts) tails the rotating file.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./configDir.js";

/** Default per-segment size cap before rotation (10 MiB). */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Default rotated backups to keep (active + .1 … .5 → ~60 MiB ceiling). */
const DEFAULT_KEEP = 5;

export type RotatingWriter = {
  /** Append a chunk, rotating first if the segment would exceed maxBytes. */
  write(chunk: string | Uint8Array): void;
  /** Active log file path. */
  readonly path: string;
};

/**
 * A size-rotating append writer. When the active segment reaches `maxBytes` it
 * is renamed to `.1` (shifting `.1`→`.2`, …, dropping the oldest beyond `keep`)
 * and a fresh segment is opened. renameSync only moves the directory entry, so
 * any fd a prior stream still holds keeps flushing to the now-renamed inode —
 * no data is lost across the swap.
 *
 * All operations are failure-tolerant: a logging error must never throw into
 * the caller's write path.
 */
export function createRotatingWriter(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
  keep: number = DEFAULT_KEEP,
): RotatingWriter {
  mkdirSync(dirname(filePath), { recursive: true });

  // Synchronous fd appends (not a WriteStream): writes are durable immediately
  // and rotation is atomic — no buffered-flush race between rename and write.
  let fd = openSync(filePath, "a"); // "a" creates the file if absent
  let bytesWritten = statSync(filePath).size;
  let rotating = false;

  function rotate(): void {
    if (rotating) return;
    rotating = true;
    try {
      closeSync(fd);
      for (let i = keep - 1; i >= 1; i--) {
        const src = `${filePath}.${i}`;
        if (existsSync(src)) renameSync(src, `${filePath}.${i + 1}`);
      }
      if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
      fd = openSync(filePath, "a");
      bytesWritten = 0;
    } catch {
      // If rotation fails, reopen the base file and keep going rather than crash.
      try {
        fd = openSync(filePath, "a");
        bytesWritten = 0;
      } catch {
        // Give up on the file writer. Surface it once — console.error still
        // echoes to the original stdout/stderr sink — so this lone runtime
        // blind spot isn't fully silent; write()'s catch swallows the rest.
        console.error("[logger] rotation failed; file logging stopped");
      }
    } finally {
      rotating = false;
    }
  }

  return {
    path: filePath,
    write(chunk: string | Uint8Array): void {
      try {
        const buf =
          typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
        if (bytesWritten + buf.length > maxBytes && bytesWritten > 0) rotate();
        writeSync(fd, buf);
        bytesWritten += buf.length;
      } catch {
        // Logging must never throw into the caller's write path.
      }
    },
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

let initialized = false;
let logFilePath = "";

/** Absolute path of the active log file, or null before init. For the CLI/tests. */
export function getLogFilePath(): string | null {
  return logFilePath || null;
}

function patch(
  std: NodeJS.WriteStream,
  writer: RotatingWriter,
  echoOnlyOnTty = false,
): void {
  const original = std.write.bind(std);
  // Echo to the original sink so existing behavior is preserved. For stdout we
  // ALWAYS echo (it carries the AUTONOMOS_READY IPC + --print-url, and under the
  // service its sink is /dev/null, so echoing is free). For stderr we echo only
  // on a TTY (dev/foreground): under the service stderr's sink is the
  // boot.error.log file, and echoing every runtime console.error there would
  // grow it unbounded — the rotating autonomos.log already captures stderr via
  // the tee, so the file backstop only needs the pre-attach window.
  const echo = echoOnlyOnTty ? Boolean(std.isTTY) : true;
  std.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    writer.write(chunk);
    if (echo) return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    // Not echoing: honor a trailing write-callback so callers never stall.
    const cb = rest.find((a) => typeof a === "function");
    if (cb) (cb as () => void)();
    return true;
  }) as typeof std.write;
}

/**
 * Begin teeing stdout/stderr into a rotating file under $configDir/logs/.
 * Idempotent and failure-tolerant: any setup error falls back to plain console
 * output rather than crashing the server. Call as early as possible in startup.
 */
export function initFileLogging(): void {
  if (initialized) return;
  initialized = true;
  try {
    const maxBytes = envInt("AUTONOMOS_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
    const keep = envInt("AUTONOMOS_LOG_KEEP", DEFAULT_KEEP);
    logFilePath = join(getConfigDir(), "logs", "autonomos.log");
    const writer = createRotatingWriter(logFilePath, maxBytes, keep);
    patch(process.stdout, writer);
    patch(process.stderr, writer, /* echoOnlyOnTty */ true);
  } catch (err) {
    // Leave stdout/stderr untouched — the server still logs to the console.
    logFilePath = "";
    console.error(
      "[logger] file logging disabled:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The server survives its stdout reader going away — `server | tee` with tee
 * killed, which is what Ctrl-C does to the whole pipeline — and shutdown still
 * runs its timed stages.
 *
 * Measured on macOS before the fix: a pipe write fails ASYNCHRONOUSLY there,
 * as an 'error' event on process.stdout. Nothing listened, so the first log
 * line after the reader closed was an uncaught exception: the server died on
 * the spot (or, mid-shutdown, right after "Shutting down…"), skipping the PTY
 * SIGTERM/SIGKILL stages and the sidecar daemons' second SIGTERM.
 *
 * A real child process, since the failure is the process dying.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(
  SERVER_PKG,
  "src",
  "__tests__",
  "fixtures",
  "epipe-shutdown-child.ts",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aos-epipe-"));
});

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

function markers(): string[] {
  const f = join(root, "markers");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
}

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; markers: ${markers()}`);
    await sleep(20);
  }
}

/** Start the child with every env-derived path isolated under `root`. */
function start(mode: "file" | "nofile" | "nologger", configDir: string) {
  const home = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AUTONOMOS_CONFIG_DIR: configDir,
    CODEX_HOME: join(home, ".codex"),
    GEMINI_CLI_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    MARKER_FILE: join(root, "markers"),
    EPIPE_MODE: mode,
  };
  const c = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    cwd: SERVER_PKG,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  c.stderr?.on("data", (d) => {
    stderr += d;
  });
  const exited = new Promise<number | null>((resolve) =>
    c.on("exit", (code) => resolve(code)),
  );
  child = c;
  return { c, exited, stderr: () => stderr };
}

/** Close stdout's read end, make the child log, then SIGTERM it. */
async function breakPipeThenStop(run: ReturnType<typeof start>) {
  await until(() => markers().includes("ready"));
  run.c.stdout?.destroy(); // the reader goes away (tee killed)
  run.c.stdin?.write("log\n"); // the next log line hits the closed pipe
  await until(() => markers().includes("logged"));
  await sleep(300); // the EPIPE 'error' event lands on a later tick
  assert.equal(
    run.c.exitCode,
    null,
    `the child died on the closed pipe: ${run.stderr()}`,
  );
  run.c.kill("SIGTERM");
  const code = await run.exited;
  return code;
}

describe("shutdown survives a closed stdout pipe", () => {
  it("with file logging: survives the EPIPE, then shutdown runs every stage", async () => {
    const run = start("file", join(root, "cfg"));
    const code = await breakPipeThenStop(run);
    assert.equal(code, 0, run.stderr());
    assert.deepEqual(markers().slice(-3), ["teardown", "escalation", "exit"]);
    // …and the lines after the break still reached the rotating log.
    const log = readFileSync(
      join(root, "cfg", "logs", "autonomos.log"),
      "utf8",
    );
    assert.match(log, /a log line after the reader went away/);
    assert.match(log, /\[child\] escalation stage/);
    assert.doesNotMatch(run.stderr(), /EPIPE/);
  });

  it("when the log file can't be opened: still survives and still shuts down", async () => {
    // The config dir sits under a regular FILE, so the log dir can't be made
    // and initFileLogging falls back to plain console output.
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "");
    const run = start("nofile", join(blocker, "cfg"));
    const code = await breakPipeThenStop(run);
    assert.equal(code, 0, run.stderr());
    assert.deepEqual(markers().slice(-3), ["teardown", "escalation", "exit"]);
    assert.match(run.stderr(), /file logging disabled/, "the fallback ran");
  });

  it("without the logger's handler, an EPIPE during shutdown still can't skip the timed stages", async () => {
    const run = start("nologger", join(root, "cfg"));
    await until(() => markers().includes("ready"));
    run.c.stdout?.destroy();
    // No log line before the signal (outside shutdown that would still be a
    // crash, by design): the FIRST write to the closed pipe is shutdown's own.
    run.c.kill("SIGTERM");
    const code = await run.exited;
    assert.equal(code, 0, run.stderr());
    assert.deepEqual(markers().slice(-3), ["teardown", "escalation", "exit"]);
    assert.match(run.stderr(), /uncaught error during shutdown/);
  });
});

// Built-in ↔ Always-on migration controller.
//
// "Make autonomOS always-on" = migrate Built-in → Always-on:
//   1. SIGTERM the Built-in server child (releases the pid file).
//   2. Spawn `autonomos install-service` from the bundled CLI binary.
//   3. LaunchAgent boots a new server which claims the pid file.
//   4. Caller (Settings / quit-prompt) re-runs acquireOrConnect() so the
//      Desktop now sees the Always-on server.
//
// "Stop running in background" = Always-on → Built-in:
//   1. Spawn `autonomos uninstall-service`.
//   2. LaunchAgent removed; daemon receives SIGTERM, pid file released.
//   3. Caller re-runs acquireOrConnect() → spawns a fresh Built-in child.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import {
  detachActiveServer,
  shutdownBuiltInServer,
} from "./server-supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrateResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function findCliBinary(): string | null {
  const p = platform();
  const a = arch();
  const target = `${p === "darwin" ? "darwin" : "linux"}-${a === "arm64" ? "arm64" : "x64"}`;
  // The CLI's entry is the same bundle as the server; the `start` /
  // `install-service` subcommands dispatch from there.
  const candidates = app.isPackaged
    ? [resolve(process.resourcesPath, "server/index.js")]
    : [
        resolve(__dirname, `../../../server/dist/${target}/index.js`),
        resolve(__dirname, `../../resources/server/index.js`),
      ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function findNodeBin(): string {
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    `${process.env.HOME}/.bun/bin/node`,
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "node";
}

function runCli(args: readonly string[]): Promise<MigrateResult> {
  return new Promise((resolveFn) => {
    const cli = findCliBinary();
    if (!cli) {
      resolveFn({ ok: false, stdout: "", stderr: "CLI bundle not found" });
      return;
    }
    const proc = spawn(findNodeBin(), [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) => {
      resolveFn({ ok: code === 0, stdout: out, stderr: err });
    });
    proc.on("error", (e) => {
      resolveFn({ ok: false, stdout: out, stderr: `${err}\n${e.message}` });
    });
  });
}

/** Built-in → Always-on. Returns success/failure + captured output for
 *  display in the migration progress dialog. */
export async function migrateToAlwaysOn(): Promise<MigrateResult> {
  // Step 1: kill the Built-in child so the pid file is released BEFORE
  // we run install-service (otherwise it would refuse).
  await shutdownBuiltInServer();
  detachActiveServer();

  // Brief delay to give the OS time to fully tear down the listening
  // socket. 200ms is conservative; the kill is synchronous after the
  // promise resolves.
  await new Promise((r) => setTimeout(r, 200));

  // Step 2: install-service spawns the LaunchAgent which boots a new
  // server. We let the LaunchAgent handle pid-file ownership.
  return runCli(["install-service"]);
}

/** Always-on → Built-in. Mirrors migrateToAlwaysOn's cache-invalidation
 *  discipline: clears the cached `activeServer` so the next
 *  acquireOrConnect() picks up the new (no-daemon) state instead of
 *  reusing the stale AlwaysOnServer reference pointing at a now-dead pid. */
export async function migrateToBuiltIn(): Promise<MigrateResult> {
  const result = await runCli(["uninstall-service"]);
  if (result.ok) {
    detachActiveServer();
    // Brief delay so launchctl's bootout / process teardown completes
    // before the next acquireOrConnect() runs.
    await new Promise((r) => setTimeout(r, 200));
  }
  return result;
}

// Server supervisor — manages the Built-in autonomos-server child process.
//
// Per ADR-029, the Desktop has two modes for the "This Mac" connection:
//   - Built-in:  Desktop spawned a server child. Server lives + dies with us.
//   - Always-on: A launchd LaunchAgent owns the server. Desktop is a thin client.
//
// acquireOrConnect() detects which mode applies by trying to spawn a Built-in
// server. The server itself (via acquireOwnership in pid-file.ts) will return
// AUTONOMOS_ALREADY_RUNNING on stdout if an Always-on daemon is already
// running — we then kill our child and connect to the existing server.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PidFileContents {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

/** Read ~/.autonomos/autonomos.pid. Returns null on missing/corrupt. */
function readPidFile(): PidFileContents | null {
  const path = resolve(homedir(), ".autonomos", "autonomos.pid");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as PidFileContents;
    if (
      typeof data.pid !== "number" ||
      typeof data.port !== "number" ||
      typeof data.version !== "string"
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** GET http://127.0.0.1:<port>/api/system/version with a short timeout.
 *  Returns true on any HTTP response (auth doesn't matter — we only need
 *  to know "is something listening and responding"). */
async function isPortResponsive(
  port: number,
  timeoutMs = 800,
): Promise<boolean> {
  return new Promise((resolveFn) => {
    let settled = false;
    const settle = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolveFn(v);
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/system/version",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () => undefined);
        settle(true);
      },
    );
    req.on("error", () => settle(false));
    req.on("timeout", () => {
      req.destroy();
      settle(false);
    });
    req.end();
  });
}

export interface BuiltInServer {
  mode: "built-in";
  port: number;
  token: string;
  child: ChildProcess;
  version: string;
  /** If set, the server is running with an isolated temp config dir at this
   *  path ("Try it out" mode). The dir is created at spawn and rm-rf'd on
   *  shutdown; nothing persists across Desktop restarts. */
  ephemeralDir?: string;
}

export interface AlwaysOnServer {
  mode: "always-on";
  port: number;
  token: string;
  pid: number;
  version: string;
}

export type LocalServer = BuiltInServer | AlwaysOnServer;

let activeServer: LocalServer | null = null;

export function getActiveServer(): LocalServer | null {
  return activeServer;
}

/** Locate a Node binary. Prefers the bundled binary in Resources/node/bin/node
 *  (shipped via bundle-node.sh in the DMG build). Falls back to system node
 *  for dev mode or if the bundled binary is missing.
 *
 *  Electron's own bundled Node cannot load node-pty's prebuilt .node files
 *  (ABI quirks), so we MUST spawn the server with a real Node binary. */
function findNodeBinary(): string {
  // First: the bundled Node shipped inside the .app.
  const bundled = app.isPackaged
    ? resolve(process.resourcesPath, "node/bin/node")
    : resolve(__dirname, "../../resources/node/bin/node");
  if (existsSync(bundled)) return bundled;

  // Fallback: system node (dev mode, or pre-bundled-node DMGs).
  const which = spawnSync("which", ["node"], { encoding: "utf-8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    `${process.env.HOME}/.bun/bin/node`,
    `${process.env.HOME}/.nvm/versions/node/current/bin/node`,
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    "node binary not found. The bundled Node should be in Resources/node/. " +
      "If running in dev mode, install Node 22+ on your PATH.",
  );
}

function findServerEntry(): string | null {
  const p = platform();
  const a = arch();
  const target = `${p === "darwin" ? "darwin" : "linux"}-${a === "arm64" ? "arm64" : "x64"}`;
  const candidates = app.isPackaged
    ? [resolve(process.resourcesPath, "server/index.js")]
    : [
        resolve(__dirname, `../../../server/dist/${target}/index.js`),
        resolve(__dirname, `../../resources/server/index.js`),
      ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function readExistingToken(): string | null {
  const path = resolve(homedir(), ".autonomos", "token");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Returns either a Built-in or Always-on server.
 *
 *  Strategy (revised after real-world test on a machine with a pre-1B.2.8
 *  LaunchAgent that doesn't know about acquireOwnership):
 *
 *    1. Read ~/.autonomos/autonomos.pid directly. If a live owner exists,
 *       use it AS-IS — no spawn needed. This works regardless of whether
 *       the running server has the new mutual-exclusion code.
 *    2. Only if NO live owner exists, spawn a Built-in server child.
 *       The child will claim the pid file on startup.
 *    3. Watch stdout for AUTONOMOS_READY port=N (or AUTONOMOS_ALREADY_RUNNING
 *       if we race against another startup).
 *
 *  This shortcut also avoids needing a `node` binary on the user's PATH
 *  when an Always-on server is already running — we never spawn in that
 *  case. node is still required for the Built-in spawn path. */
export async function acquireOrConnect(): Promise<LocalServer> {
  if (activeServer) return activeServer;

  // Fast path: an existing daemon is already running. Just use it.
  const existing = readPidFile();
  if (
    existing &&
    isPidAlive(existing.pid) &&
    (await isPortResponsive(existing.port))
  ) {
    const token = readExistingToken() ?? "";
    const server: AlwaysOnServer = {
      mode: "always-on",
      port: existing.port,
      pid: existing.pid,
      token,
      version: existing.version,
    };
    activeServer = server;
    return server;
  }

  // No live owner — we'll spawn a Built-in server.
  const entry = findServerEntry();
  if (!entry) {
    throw new Error(
      `Server bundle not found. ${
        app.isPackaged
          ? "This DMG may be corrupted."
          : "Run `bun run build:binary` from repo root."
      }`,
    );
  }

  const nodeBin = findNodeBinary();

  // Token: prefer the existing ~/.autonomos/token if present (lets Built-in
  // and Always-on share auth). Otherwise generate a fresh one.
  const token = readExistingToken() ?? randomBytes(32).toString("hex");

  const child = spawn(nodeBin, [entry, "--embedded", "--port=0"], {
    env: { ...process.env, AUTONOMOS_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<LocalServer>((resolveFn, rejectFn) => {
    let resolved = false;

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[server] ${text}`);
      if (resolved) return;

      const ready = text.match(/AUTONOMOS_READY port=(\d+)/);
      if (ready) {
        resolved = true;
        const server: BuiltInServer = {
          mode: "built-in",
          port: Number(ready[1]),
          token,
          child,
          version: "unknown",
        };
        activeServer = server;
        resolveFn(server);
        return;
      }

      const already = text.match(
        /AUTONOMOS_ALREADY_RUNNING port=(\d+) pid=(\d+)/,
      );
      if (already) {
        resolved = true;
        // Our child will exit on its own (server.close() in run.ts). Kill
        // anyway as belt-and-suspenders so we don't leak the helper.
        child.kill("SIGTERM");
        const existingToken = readExistingToken() ?? token;
        const server: AlwaysOnServer = {
          mode: "always-on",
          port: Number(already[1]),
          pid: Number(already[2]),
          token: existingToken,
          version: "unknown",
        };
        activeServer = server;
        resolveFn(server);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`[server:err] ${data.toString()}`);
    });

    child.on("exit", (code, signal) => {
      if (!resolved) {
        rejectFn(
          new Error(
            `Server exited before signaling ready (code=${code} signal=${signal})`,
          ),
        );
      }
    });

    child.on("error", (err) => {
      if (!resolved) rejectFn(err);
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGKILL");
        rejectFn(new Error("Server failed to signal ready within 30s"));
      }
    }, 30_000);
  });
}

/** Spawn an ephemeral ("Try it out") server: brand-new config dir under
 *  os.tmpdir(), brand-new auth token, brand-new everything. Nothing reads
 *  from or writes to the user's ~/.autonomos/. On shutdown the temp dir
 *  is rm-rf'd in `shutdownBuiltInServer()`.
 *
 *  Unlike `acquireOrConnect()` we deliberately do NOT consult the pid file
 *  or fall back to an Always-on daemon — the whole point is isolation. */
export async function acquireEphemeral(): Promise<BuiltInServer> {
  if (activeServer) {
    throw new Error(
      `Cannot start Try-It-Out mode: a ${activeServer.mode} server is already active. Quit the Desktop first.`,
    );
  }

  const entry = findServerEntry();
  if (!entry) {
    throw new Error(
      `Server bundle not found. ${
        app.isPackaged
          ? "This DMG may be corrupted."
          : "Run `bun run build:binary` from repo root."
      }`,
    );
  }

  const nodeBin = findNodeBinary();
  const ephemeralDir = join(tmpdir(), `autonomos-ephemeral-${randomUUID()}`);
  mkdirSync(ephemeralDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");

  const child = spawn(nodeBin, [entry, "--embedded", "--port=0"], {
    env: {
      ...process.env,
      AUTONOMOS_CONFIG_DIR: ephemeralDir,
      AUTONOMOS_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<BuiltInServer>((resolveFn, rejectFn) => {
    let resolved = false;

    const fail = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      try {
        rmSync(ephemeralDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — temp dir will be GC'd by macOS eventually.
      }
      rejectFn(err);
    };

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[server:ephemeral] ${text}`);
      if (resolved) return;
      const ready = text.match(/AUTONOMOS_READY port=(\d+)/);
      if (ready) {
        resolved = true;
        const server: BuiltInServer = {
          mode: "built-in",
          port: Number(ready[1]),
          token,
          child,
          version: "unknown",
          ephemeralDir,
        };
        activeServer = server;
        resolveFn(server);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`[server:ephemeral:err] ${data.toString()}`);
    });

    child.on("exit", (code, signal) => {
      fail(
        new Error(
          `Try-It-Out server exited before signaling ready (code=${code} signal=${signal})`,
        ),
      );
    });

    child.on("error", (err) => fail(err));

    setTimeout(() => {
      fail(new Error("Try-It-Out server failed to signal ready within 30s"));
      child.kill("SIGKILL");
    }, 30_000);
  });
}

/** Gracefully shut down the Built-in server (if any). Safe to call in
 *  any mode — Always-on servers are not touched. If the active server is
 *  in ephemeral / "Try it out" mode, the temp config dir is rm-rf'd after
 *  the child exits. */
export async function shutdownBuiltInServer(graceMs = 5000): Promise<void> {
  if (!activeServer || activeServer.mode !== "built-in") return;
  const child = activeServer.child;
  const ephemeralDir = activeServer.ephemeralDir;

  const cleanupEphemeral = (): void => {
    if (!ephemeralDir) return;
    try {
      rmSync(ephemeralDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[server-supervisor] failed to clean ephemeral dir ${ephemeralDir}:`,
        err,
      );
    }
  };

  if (child.exitCode !== null) {
    cleanupEphemeral();
    activeServer = null;
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolveFn) => {
    let timer: NodeJS.Timeout;
    const onExit = (): void => {
      clearTimeout(timer);
      resolveFn();
    };
    child.once("exit", onExit);
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      child.kill("SIGKILL");
      resolveFn();
    }, graceMs);
  });
  cleanupEphemeral();
  activeServer = null;
}

/** Best-effort cleanup of leaked ephemeral dirs from prior Desktop crashes.
 *  We scan os.tmpdir() for `autonomos-ephemeral-*` and remove any that are
 *  older than 1 hour. macOS auto-cleans $TMPDIR every ~3 days, but eager
 *  cleanup at boot keeps the dir count from drifting and surfaces stale
 *  state sooner. Called from main.ts during bootstrap. */
export function cleanupLeakedEphemeralDirs(): void {
  try {
    const root = tmpdir();
    const entries = readdirSync(root);
    const ageThresholdMs = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith("autonomos-ephemeral-")) continue;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        if (now - stat.mtimeMs > ageThresholdMs) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // Ignore — best-effort.
      }
    }
  } catch {
    // Ignore — tmpdir unreachable is non-fatal.
  }
}

/** Forget the active server reference without killing anything. Used after
 *  migration to Always-on mode (LaunchAgent now owns the daemon; we just
 *  reconnect as a thin client). */
export function detachActiveServer(): void {
  activeServer = null;
}

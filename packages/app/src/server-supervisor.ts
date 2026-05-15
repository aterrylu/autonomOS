// Spawns the autonomos-server bundle as a child process and manages its
// lifecycle. Implements the Phase 1A.1 contract:
//   - Spawn with `--embedded --port=0` (localhost-only, OS-assigned port)
//   - Parse `AUTONOMOS_READY port=<N>` line from the child's stdout
//   - Capture the actual port for the BrowserWindow to load
//   - On Electron shutdown, send SIGTERM and wait briefly for graceful exit
//
// Path resolution:
//   - Packaged (app.isPackaged):  Resources/server/index.js (from extraResources)
//   - Dev / unpackaged:           ../../server/dist/<host-platform>/index.js
//                                  (built via `bun run build:binary` from repo root)

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ServerHandle = {
  port: number;
  token: string;
  child: ChildProcess;
};

/**
 * Walk a list of candidate paths and return the first that exists, or null.
 * Used so dev mode finds the bundled server in the worktree's dist/ even
 * though we don't know exactly where electron-builder will place things
 * yet — be permissive in the search.
 */
function findServerEntry(): string | null {
  const hostTarget = hostPlatformLabel();
  const candidates = app.isPackaged
    ? [resolve(process.resourcesPath, "server/index.js")]
    : [
        // Built locally by `bun run build:binary`. Adjust the relative
        // path as the worktree layout settles.
        resolve(__dirname, `../../server/dist/${hostTarget}/index.js`),
      ];
  return candidates.find(existsSync) ?? null;
}

/**
 * Locate a node binary to spawn the server with.
 *
 * We cannot use process.execPath (the Electron binary) with
 * ELECTRON_RUN_AS_NODE=1, because Electron's bundled Node has subtle ESM +
 * native-module differences that break node-pty's `require('pty.node')`.
 * The server runs cleanly under plain Node, so we look for a real node
 * binary on the user's PATH or in well-known locations.
 *
 * Phase 1B follow-up: bundle a node binary inside the .app at build time
 * so we don't rely on the user having node installed.
 */
function findNodeBinary(): string {
  // Check PATH first
  const pathResult = spawnSync("node", ["--version"], { encoding: "utf-8" });
  if (pathResult.status === 0) return "node";

  // Common install locations
  const candidates = [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    `${process.env.HOME}/.nvm/versions/node/v22.0.0/bin/node`,
    `${process.env.HOME}/.volta/bin/node`,
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  throw new Error(
    "node binary not found in PATH or common install locations. " +
      "Install Node 22+ or rebuild with a bundled node binary.",
  );
}

function hostPlatformLabel(): string {
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "linux" && a === "x64") return "linux-x64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  throw new Error(`Unsupported platform for embedded server: ${p}/${a}`);
}

/**
 * Spawn the autonomos-server child and resolve once the AUTONOMOS_READY
 * signal arrives on stdout. Rejects if the child exits before signaling.
 *
 * `token` is generated here and passed in via env var so the Electron
 * webview can authenticate without prompting the user. Same token gets
 * set as a cookie on the session before the dashboard URL loads.
 */
export async function spawnServer(): Promise<ServerHandle> {
  const entry = findServerEntry();
  if (!entry) {
    throw new Error(
      `Server bundle not found. In dev: run \`bun run build:binary\` from repo root.`,
    );
  }

  const token = generateAuthToken();
  const nodeBin = findNodeBinary();
  const child = spawn(nodeBin, [entry, "--embedded", "--port=0"], {
    env: {
      ...process.env,
      AUTONOMOS_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<ServerHandle>((resolveFn, rejectFn) => {
    let resolved = false;

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[server] ${text}`);
      if (!resolved) {
        const match = text.match(/AUTONOMOS_READY port=(\d+)/);
        if (match) {
          resolved = true;
          resolveFn({ port: Number(match[1]), token, child });
        }
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
  });
}

/**
 * Send SIGTERM to the server child and wait up to `graceMs` for it to exit.
 * Escalates to SIGKILL if the grace period elapses with the process still
 * alive. Best-effort — does not throw.
 */
export async function shutdownServer(
  handle: ServerHandle | null,
  graceMs = 5000,
): Promise<void> {
  if (!handle || handle.child.exitCode !== null) return;
  handle.child.kill("SIGTERM");
  await new Promise<void>((resolveFn) => {
    let timer: NodeJS.Timeout;
    const onExit = () => {
      clearTimeout(timer);
      resolveFn();
    };
    handle.child.once("exit", onExit);
    timer = setTimeout(() => {
      handle.child.removeListener("exit", onExit);
      handle.child.kill("SIGKILL");
      resolveFn();
    }, graceMs);
  });
}

function generateAuthToken(): string {
  // 32 bytes hex = 64 chars, matches the format the server's auth.ts uses
  // when it auto-generates a token. We pass it in via AUTONOMOS_TOKEN env
  // var so the server uses our value instead of generating its own.
  return randomBytes(32).toString("hex");
}

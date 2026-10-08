// `autonomos token rotate | status` — replace or inspect the operator token.
//
// The operator token is the dashboard/API credential. Installs that set a short
// AUTONOMOS_TOKEN years ago keep working after an upgrade (upgrades never break
// auth), but a short token can be guessed over the network, so the server warns
// on every boot until it's rotated (V2b, ADR-130). This verb is the one-step fix.
//
// rotate:
//   1. Writes a fresh 64-hex token to $configDir/token (0600, atomic rename).
//   2. The server prefers the AUTONOMOS_TOKEN environment variable over that
//      file, so an env-set token would keep winning and the rotation would do
//      nothing. rotate comments the line out of every .env the server reads
//      that it can find: --env-file=PATH, a source install's repo .env, and
//      any --env-file the installed service (or its wrapper script) loads. It
//      keeps nothing of the old value. Then it names, loudly, what it could
//      NOT change: a token in the service definition itself, or in this shell.
//   3. Prints the new sign-in link to the terminal only (never a log), and
//      says the running server keeps the old token until it restarts, after
//      which the old link and old sessions stop working.
// status: strong or weak, how long, and where it comes from. Never the value.
//
// Exit codes: 0 done · 1 failed · 64 usage.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isWeakToken, peekAuthToken } from "@autonomos/server/auth.js";
import { signInLink } from "@autonomos/server/authCookie.js";
import { getConfigDir } from "@autonomos/server/configDir.js";
import { resolveInstall } from "@autonomos/server/installInfo.js";
import {
  loadState,
  NEW_DEVICE_FAILURE_LIMIT,
  newDeviceLockPath,
} from "@autonomos/server/newDeviceLock.js";
import { isPidAlive, readPidFile } from "@autonomos/server/pid-file.js";
import { findInstalledService } from "../lib/service-control.js";

const USAGE = `Usage: autonomos token <rotate|status> [options]

  rotate               Replace the operator token with a strong random one
    --env-file=PATH    Also take AUTONOMOS_TOKEN out of this .env file (a
                       source install's .env, and any .env the installed
                       service loads, are found on their own)
  status               Say whether the token is strong, and where it comes from
`;

export async function runTokenCommand(
  argv: readonly string[],
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "rotate") return rotate(rest);
  if (sub === "status") return await status();
  process.stderr.write(USAGE);
  return 64;
}

/** Comment out every active `AUTONOMOS_TOKEN=` line, keeping nothing of its
 *  value in the file. `removed` holds the old values IN MEMORY ONLY, so the
 *  caller can tell whether this process's env came from this file. Exported
 *  for tests. */
export function removeEnvToken(
  content: string,
  note: string,
): { content: string; changed: boolean; removed: string[] } {
  const removed: string[] = [];
  const lines = content.split("\n").map((line) => {
    const m = /^\s*(?:export\s+)?AUTONOMOS_TOKEN\s*=\s*(.*)$/.exec(line);
    if (!m) return line;
    removed.push(m[1].trim().replace(/^(['"])(.*)\1$/, "$2"));
    return `# AUTONOMOS_TOKEN removed by \`autonomos token rotate\` ${note}`;
  });
  return { content: lines.join("\n"), changed: removed.length > 0, removed };
}

/**
 * What the installed service definition tells us: whether it sets
 * AUTONOMOS_TOKEN itself (plists and units aren't edited: we say so), and
 * which .env files it loads. `make prod` supervises a generated wrapper script
 * that runs `tsx --env-file="<repo>/.env"`, so small scripts the definition
 * points at are followed one level. Exported for tests.
 */
export function inspectServiceDefinition(serviceFile: string): {
  setsToken: boolean;
  envFiles: string[];
} {
  let text: string;
  try {
    text = readFileSync(serviceFile, "utf8");
  } catch {
    return { setsToken: false, envFiles: [] };
  }
  const envFiles = new Set<string>();
  const scan = (body: string) => {
    for (const m of body.matchAll(/--env-file=["']?([^"'\s<>]+)/g))
      envFiles.add(m[1]);
  };
  scan(text);
  for (const m of text.matchAll(/(\/[^\s"'<>]+)/g)) {
    try {
      const st = statSync(m[1]);
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const body = readFileSync(m[1], "utf8");
      if (body.startsWith("#!")) scan(body);
    } catch {
      // not a readable file: skip
    }
  }
  return { setsToken: /AUTONOMOS_TOKEN/.test(text), envFiles: [...envFiles] };
}

/** The .env files the server may read AUTONOMOS_TOKEN from. */
function envFileCandidates(
  explicit: string | undefined,
  fromService: readonly string[],
): string[] {
  const out: string[] = [];
  if (explicit) out.push(explicit);
  out.push(...fromService);
  try {
    const install = resolveInstall();
    // install-source runs the server with the managed clone's .env.
    if (install.info.mode === "source")
      out.push(join(install.bundleDir, ".env"));
  } catch {
    // A plain dev checkout has no install marker: nothing to find.
  }
  return [...new Set(out)];
}

function writeAtomic(path: string, content: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode); // the umask may have narrowed it
  renameSync(tmp, path);
}

function rotate(args: readonly string[]): number {
  let envFile: string | undefined;
  for (const a of args) {
    if (a.startsWith("--env-file=")) envFile = a.slice("--env-file=".length);
    else {
      process.stderr.write(`Unknown option: ${a}\n\n${USAGE}`);
      return 64;
    }
  }

  const configDir = getConfigDir();
  const tokenPath = join(configDir, "token");
  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeAtomic(tokenPath, token, 0o600);
  } catch (err) {
    console.error(
      `✖ Couldn't write ${tokenPath}: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
  console.log(`✓ New operator token written to ${tokenPath} (64 characters).`);

  // An env-set token outranks the file: take it out of every .env the server
  // reads that we can find, then name anywhere it's still set. A rotation an
  // env var silently overrides would do nothing (SecurityAudit, V2b review).
  const svc = findInstalledService();
  const service = svc
    ? inspectServiceDefinition(svc.serviceFile)
    : { setsToken: false, envFiles: [] };
  const removedValues: string[] = [];
  let envPort: number | undefined; // PORT from a .env the server loads
  const when = new Date().toISOString().slice(0, 10);
  for (const file of envFileCandidates(envFile, service.envFiles)) {
    if (!existsSync(file)) {
      if (file === envFile) console.warn(`⚠ ${file} doesn't exist; skipped.`);
      continue;
    }
    try {
      const before = readFileSync(file, "utf8");
      const port = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d+)/m.exec(before);
      if (port && envPort === undefined) envPort = Number(port[1]);
      const { content, changed, removed } = removeEnvToken(
        before,
        `on ${when}; the token now lives in ${tokenPath}`,
      );
      if (changed) {
        writeAtomic(file, content, statSync(file).mode & 0o777);
        removedValues.push(...removed);
        console.log(`✓ Took AUTONOMOS_TOKEN out of ${file}.`);
      }
    } catch (err) {
      console.error(
        `✖ Couldn't update ${file}: ${err instanceof Error ? err.message : err}. Remove its AUTONOMOS_TOKEN line by hand, or the server keeps the old token.`,
      );
      return 1;
    }
  }

  const stillOverriding: string[] = [];
  if (svc && service.setsToken)
    stillOverriding.push(
      `the service definition ${svc.serviceFile}: remove its AUTONOMOS_TOKEN entry, then run \`autonomos install-service --force\``,
    );
  const envNow = process.env.AUTONOMOS_TOKEN?.trim();
  // Came from a .env we just cleaned (e.g. this command ran through the
  // --env-file wrapper)? Then it won't be set on the next start.
  if (envNow && !removedValues.includes(envNow))
    stillOverriding.push(
      "this shell's environment: remove it from your shell profile, or wherever you export it",
    );
  if (stillOverriding.length > 0) {
    console.warn("");
    console.warn(
      "⚠ AUTONOMOS_TOKEN is still set, and the server uses it INSTEAD of the new token file:",
    );
    for (const w of stillOverriding) console.warn(`    - ${w}`);
    console.warn("  Until it's removed, rotating changes nothing.");
  }

  const pid = readPidFile();
  const running = pid !== null && isPidAlive(pid.pid);
  // The port the server really uses: running → its pid file; else the PORT
  // its .env or this shell sets; else the default (SecurityAudit, #459).
  // A stale pid file (after a crash) must not win (nox, #459).
  const port =
    (running ? pid?.port : undefined) ??
    envPort ??
    (Number(process.env.PORT) || undefined) ??
    3100;
  const base = `http://localhost:${port}`;
  console.log("");
  console.log(
    running
      ? "The running server keeps the OLD token until it restarts: run `autonomos restart` (or restart it however you started it). After the restart the old sign-in link stops working, and every browser signed in with the old token is signed out."
      : "Start the server to use it. Browsers signed in with the old token will need the new link.",
  );
  console.log("Sign in with this link (shown here once, never logged):");
  console.log(`  ${signInLink(base, token)}`);
  console.log(
    "Use your server's own address in place of localhost if you reach it from another machine.",
  );
  return 0;
}

async function status(): Promise<number> {
  // Read-only: never generates a token file (nox, #459).
  const found = peekAuthToken();
  if (!found) {
    console.log(
      `No operator token yet: the server generates a strong one in ${join(getConfigDir(), "token")} on its first start.`,
    );
    return 0;
  }
  const { token, source } = found;
  const where =
    source === "env"
      ? "the AUTONOMOS_TOKEN environment variable (as seen from this shell)"
      : `${found.path}${source === "legacy-file" ? " (the default config dir's token, used because this config dir has none)" : ""}`;
  const weak = isWeakToken(token);
  // Length and source only, never any characters of the token (V8).
  console.log(
    `Operator token: ${weak ? "WEAK" : "strong"}, ${token.length} characters, from ${where}.`,
  );
  if (weak) {
    // A short token is protected by the new-device lock (ADR-148): say where
    // it stands. Counts only, never anything about the token itself.
    const lock = loadState(newDeviceLockPath(getConfigDir()));
    console.log(
      lock.lockedAt !== null
        ? `New devices: LOCKED OUT after ${lock.failures} failed sign-ins (since ${new Date(lock.lockedAt).toISOString()}). Devices already signed in still work. Run \`autonomos auth unlock\` to reopen.`
        : `New devices: open (${lock.failures} of ${NEW_DEVICE_FAILURE_LIMIT} failed sign-ins before they're locked out).`,
    );
    console.log(
      "`autonomos token rotate` replaces the token with a strong one.",
    );
  }
  // How the running server treats a reverse proxy (ADR-140): only it knows
  // (the mode comes from its own flags/env), so ask it over loopback.
  const pid = readPidFile();
  if (pid && isPidAlive(pid.pid)) {
    try {
      const res = await fetch(`http://127.0.0.1:${pid.port}/api/auth/lock`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await res.json()) as { trustProxy?: string };
      if (body.trustProxy === "tailscale")
        console.log(
          "Trusted proxy: tailscale serve. A request it forwards counts as the visitor's tailnet device; the server listens on this machine only.",
        );
      else if (body.trustProxy === "off")
        console.log(
          "Trusted proxy: none. Every device is identified by its own network address.",
        );
    } catch {
      // Not answering, or an older server: say nothing rather than guess.
    }
  }
  return 0;
}

// `autonomos token rotate | status` — replace or inspect the operator token.
//
// The operator token is the dashboard/API credential. Installs that set a short
// AUTONOMOS_TOKEN years ago keep working after an upgrade (upgrades never break
// auth), but a short token can be guessed over the network, so the server warns
// on every boot until it's rotated (V2b, ADR-127). This verb is the one-step fix.
//
// rotate:
//   1. Writes a fresh 64-hex token to $configDir/token (0600, atomic rename).
//   2. The server prefers the AUTONOMOS_TOKEN environment variable over that
//      file, so an env-set token would keep winning. rotate comments the line
//      out of the .env the server reads (a source install's repo .env, or
//      --env-file=PATH) without keeping the old value. It also warns if THIS
//      shell exports it.
//   3. Prints the new sign-in link to the terminal only (never a log), and
//      says the running server keeps the old token until it restarts.
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
import { dirname, join } from "node:path";
import {
  isWeakToken,
  resolveAuthTokenWithSource,
} from "@autonomos/server/auth.js";
import { signInLink } from "@autonomos/server/authCookie.js";
import { getConfigDir } from "@autonomos/server/configDir.js";
import { resolveInstall } from "@autonomos/server/installInfo.js";
import { isPidAlive, readPidFile } from "@autonomos/server/pid-file.js";

const USAGE = `Usage: autonomos token <rotate|status> [options]

  rotate               Replace the operator token with a strong random one
    --env-file=PATH    Also take AUTONOMOS_TOKEN out of this .env file
                       (a source install's repo .env is found on its own)
  status               Say whether the token is strong, and where it comes from
`;

export async function runTokenCommand(
  argv: readonly string[],
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "rotate") return rotate(rest);
  if (sub === "status") return status();
  process.stderr.write(USAGE);
  return 64;
}

/** Comment out every active `AUTONOMOS_TOKEN=` line, keeping nothing of its
 *  value. Exported for tests. */
export function removeEnvToken(
  content: string,
  note: string,
): {
  content: string;
  changed: boolean;
} {
  let changed = false;
  const lines = content.split("\n").map((line) => {
    if (/^\s*(export\s+)?AUTONOMOS_TOKEN\s*=/.test(line)) {
      changed = true;
      return `# AUTONOMOS_TOKEN removed by \`autonomos token rotate\` ${note}`;
    }
    return line;
  });
  return { content: lines.join("\n"), changed };
}

/** The .env files the server may read AUTONOMOS_TOKEN from. */
function envFileCandidates(explicit: string | undefined): string[] {
  const out: string[] = [];
  if (explicit) out.push(explicit);
  try {
    const install = resolveInstall();
    // install-source / install-prod-service run the server with the managed
    // clone's .env (tsx --env-file).
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

  // An env-set token outranks the file: take it out of the .env files the
  // server reads, and point at anywhere else it's still set.
  const when = new Date().toISOString().slice(0, 10);
  for (const file of envFileCandidates(envFile)) {
    if (!existsSync(file)) {
      if (file === envFile) console.warn(`⚠ ${file} doesn't exist; skipped.`);
      continue;
    }
    try {
      const before = readFileSync(file, "utf8");
      const { content, changed } = removeEnvToken(
        before,
        `on ${when}; the token now lives in ${tokenPath}`,
      );
      if (changed) {
        writeAtomic(file, content, statSync(file).mode & 0o777);
        console.log(`✓ Took AUTONOMOS_TOKEN out of ${file}.`);
      }
    } catch (err) {
      console.error(
        `✖ Couldn't update ${file}: ${err instanceof Error ? err.message : err}. Remove its AUTONOMOS_TOKEN line by hand, or the server keeps the old token.`,
      );
      return 1;
    }
  }
  if (process.env.AUTONOMOS_TOKEN)
    console.warn(
      "⚠ This shell exports AUTONOMOS_TOKEN. The server prefers it over the token file, so remove it from wherever it is set (your shell profile, a service definition, another .env) before restarting.",
    );

  const pid = readPidFile();
  const running = pid !== null && isPidAlive(pid.pid);
  const base = `http://localhost:${pid?.port ?? 3100}`;
  console.log("");
  console.log(
    running
      ? "The running server keeps the OLD token until it restarts: run `autonomos restart` (or restart it however you started it)."
      : "Start the server to use it.",
  );
  console.log("Then sign in with this link (shown here once, never logged):");
  console.log(`  ${signInLink(base, token)}`);
  console.log(
    "Use your server's own address in place of localhost if you reach it from another machine.",
  );
  return 0;
}

function status(): number {
  const { token, source } = resolveAuthTokenWithSource();
  const where =
    source === "env"
      ? "the AUTONOMOS_TOKEN environment variable (as seen from this shell)"
      : source === "generated"
        ? "a newly generated token file"
        : `the token file in ${dirname(join(getConfigDir(), "token"))}`;
  const weak = isWeakToken(token);
  console.log(
    `Operator token: ${weak ? "WEAK" : "strong"}, ${token.length} characters, from ${where}.`,
  );
  if (weak) console.log("Run `autonomos token rotate` to replace it.");
  return 0;
}

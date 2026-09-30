/**
 * Where a Codex agent's `app-server` daemon listens (security audit V4).
 *
 * The daemon used to listen on loopback TCP (`ws://127.0.0.1:<port>`) with no
 * authentication, and it runs `danger-full-access`: any local process of any
 * user could connect, send `initialize` + `command/exec`, and run commands as
 * the operator (the audit's PoC). Codex's `--ws-auth` only applies to
 * non-loopback listeners.
 *
 * Now it listens on a Unix socket. Measured on codex-cli 0.157.1:
 * - `--listen unix://PATH` makes PATH a SYMLINK to the real socket,
 *   `/tmp/codex-daemon-<uid>/<sha256(PATH)>`, in a 0700 directory, socket 0600.
 *   Other users can't connect. The protocol on it is still WebSocket.
 * - The daemon prints no "listening on" banner for a unix listener, so
 *   readiness is "the socket exists, checks out, and accepts a connection".
 * - A second daemon on the same PATH exits "control socket is already in use"
 *   while the first keeps it. So PATH carries a per-spawn nonce: a respawn
 *   never collides with (or attaches to) an orphaned daemon from before.
 * - `codex --remote unix://PATH` attaches the TUI.
 *
 * When unix can't be used, the outcome depends on WHO could have caused it:
 * - COMPAT (this Codex can't listen on unix; the path is too long): loopback
 *   TCP with a loud notice. Honest users hit these; an attacker can't trigger
 *   them. (TeamLead: an upgrade must not break an older-Codex setup.)
 * - HOSTILE (the daemon dir is a symlink or another user's; the socket fails
 *   verification after start): refuse THAT spawn, loudly, never TCP. Otherwise
 *   another local user could squat /tmp/codex-daemon-<uid> and downgrade every
 *   Codex agent back to the exec-over-TCP endpoint (review of V4).
 * - Our own directory with loose permissions: tightened to 0700 in place.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { getConfigDir } from "../configDir.js";

/** macOS sun_path is 104 bytes including the NUL; Linux is 108. Our client
 *  connects to the symlink path, so that path is what must fit. */
export const MAX_SOCKET_PATH_BYTES = 103;

export type SidecarEndpointChoice =
  | { kind: "unix"; endpoint: string; socketPath: string }
  /** Compatibility fallback: loopback TCP, with a notice. */
  | { kind: "tcp"; reason: string }
  /** Hostile state: don't spawn this agent at all. */
  | { kind: "refuse"; reason: string };

// ── Capability probe (async, never on the event loop) ──────────────────────

/** A definite answer from the help text, or `unknown` when the probe itself
 *  failed (error or timeout). */
export type UnixSupport = "yes" | "no" | "unknown";

const supportCache = new Map<string, UnixSupport>();

/** Whether this codex binary's app-server accepts `--listen unix://`, from its
 *  own help text. Async so the first Codex spawn doesn't stall the server's
 *  event loop for the CLI's start-up time. Only a DEFINITE answer is cached
 *  (per binary path AND mtime, so an in-place upgrade is re-probed): a probe
 *  that errored or timed out on a loaded box must not pin every later Codex
 *  agent to TCP, with a notice blaming the wrong cause (review of V4). */
export async function codexSupportsUnixListen(
  binary: string,
): Promise<UnixSupport> {
  let key = binary;
  try {
    key = `${binary}@${statSync(binary).mtimeMs}`;
  } catch {
    // A bare command name resolved via PATH: key by name only.
  }
  const cached = supportCache.get(key);
  if (cached) return cached;
  const answer = await new Promise<UnixSupport>((resolveP) => {
    execFile(
      binary,
      ["app-server", "--help"],
      { encoding: "utf8", timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) return resolveP("unknown");
        resolveP(/unix:\/\//.test(`${stdout}${stderr}`) ? "yes" : "no");
      },
    );
  });
  if (answer !== "unknown") supportCache.set(key, answer);
  return answer;
}

export function _resetCodexSocketCacheForTesting(): void {
  supportCache.clear();
}

// ── Paths ───────────────────────────────────────────────────────────────────

/** Per-agent prefix; the socket name adds a per-spawn nonce after it. */
function agentPrefix(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 12);
}

/** A fresh socket path for one spawn of this agent: short, so long config
 *  dirs still fit, and unique, so it never meets an orphaned daemon. */
export function codexSocketPath(
  agentId: string,
  configDir = getConfigDir(),
  nonce = randomBytes(4).toString("hex"),
): string {
  return join(configDir, "cx", `${agentPrefix(agentId)}-${nonce}.sock`);
}

/** The directory codex puts its real sockets in: /tmp/codex-daemon-<uid>. */
export function codexDaemonDir(uid = process.getuid?.()): string {
  return join("/tmp", `codex-daemon-${uid}`);
}

// ── Directory trust ─────────────────────────────────────────────────────────

/** The slice of an lstat result judgeDir reads (injectable for tests). */
export interface StatLike {
  uid: number;
  mode: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export type DirVerdict =
  | { ok: true }
  | { ok: false; hostile: false; loose: true; reason: string }
  | { ok: false; hostile: true; reason: string };

/**
 * Judge a directory we are about to trust with the daemon's socket. Symlinked,
 * not a directory, or another user's → hostile (only someone else could have
 * made it so). Ours but readable by others → loose (fixable in place).
 * `lstat` is injectable so tests can present another uid's directory.
 */
export function judgeDir(
  dir: string,
  uid = process.getuid?.(),
  lstat: (p: string) => StatLike = lstatSync,
): DirVerdict {
  let st: StatLike;
  try {
    st = lstat(dir);
  } catch {
    return { ok: false, hostile: true, reason: `${dir} does not exist` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, hostile: true, reason: `${dir} is a symlink` };
  }
  if (!st.isDirectory()) {
    return { ok: false, hostile: true, reason: `${dir} is not a directory` };
  }
  if (uid !== undefined && st.uid !== uid) {
    return {
      ok: false,
      hostile: true,
      reason: `${dir} is owned by uid ${st.uid}, not ${uid}`,
    };
  }
  if ((st.mode & 0o077) !== 0) {
    return {
      ok: false,
      hostile: false,
      loose: true,
      reason: `${dir} is mode ${(st.mode & 0o777).toString(8)}, not 700`,
    };
  }
  return { ok: true };
}

/** Create `dir` 0700 if absent (so we, not another user, own it); tighten our
 *  own loose dir; report a hostile one. Returns null when usable. */
function ensurePrivateDir(
  dir: string,
  lstat?: (p: string) => StatLike,
): string | null {
  try {
    mkdirSync(dir, { mode: 0o700, recursive: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return `could not create ${dir}: ${(err as Error).message}`;
    }
  }
  const verdict = judgeDir(dir, undefined, lstat);
  if (verdict.ok) return null;
  if (verdict.hostile) return verdict.reason;
  chmodSync(dir, 0o700);
  const again = judgeDir(dir, undefined, lstat);
  return again.ok ? null : again.reason;
}

// ── Stale entries ───────────────────────────────────────────────────────────

/**
 * Remove sockets/symlinks left in cx/ by earlier spawns of THIS agent (it isn't
 * running while it spawns). Never touches other agents' entries, never
 * connects to what it removes, and unlink removes a link, never its target.
 */
export function sweepStaleSockets(agentId: string, cxDir: string): void {
  const prefix = `${agentPrefix(agentId)}-`;
  let names: string[];
  try {
    names = readdirSync(cxDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".sock")) continue;
    const p = join(cxDir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || st.isSocket()) unlinkSync(p);
    } catch {
      // gone already, or not ours to remove: the nonce path avoids it anyway
    }
  }
}

// ── After start: verify before anything connects ────────────────────────────

/**
 * The socket codex created must resolve to a socket we own, in a private
 * directory, created by THIS spawn (not an older daemon's). Returns null when
 * it checks out.
 */
export function verifyDaemonSocket(
  socketPath: string,
  notBeforeMs = 0,
): string | null {
  let real: string;
  try {
    real = realpathSync(socketPath);
  } catch (err) {
    return `socket ${socketPath} unresolvable: ${(err as Error).message}`;
  }
  const dir = judgeDir(dirname(real));
  if (!dir.ok) return `socket directory unsafe: ${dir.reason}`;
  const st = statSync(real);
  if (!st.isSocket()) return `${real} is not a socket`;
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return `${real} is not owned by us`;
  // Filesystem timestamps can be coarser than the clock; allow 1s of slack.
  if (st.ctimeMs < notBeforeMs - 1_000) {
    return `${real} predates this spawn (an older daemon's socket)`;
  }
  return null;
}

/** A hostile state: refuse the spawn, never fall back to TCP. */
export class UnsafeCodexSocketError extends Error {
  constructor(problem: string) {
    super(`unsafe Codex socket, not used: ${problem}`);
    this.name = "UnsafeCodexSocketError";
  }
}

/** True once something accepts a connection on the socket. */
export function socketAccepts(
  socketPath: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolveP) => {
    const s = connect(socketPath);
    const done = (ok: boolean) => {
      s.removeAllListeners();
      s.destroy();
      resolveP(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => {
      clearTimeout(t);
      done(true);
    });
    s.once("error", () => {
      clearTimeout(t);
      done(false);
    });
  });
}

/**
 * The readiness probe for a unix daemon: not created yet → false; created but
 * failing verifyDaemonSocket → throws UnsafeCodexSocketError (the caller
 * refuses the spawn, and nothing ever connected); verified → does it accept?
 * `spawnStartedAt` rejects an older daemon's socket.
 */
export function codexReadyProbe(
  socketPath: string,
  spawnStartedAt: number,
): () => Promise<boolean> {
  return async () => {
    try {
      lstatSync(socketPath);
    } catch {
      return false; // not created yet
    }
    const problem = verifyDaemonSocket(socketPath, spawnStartedAt);
    if (problem) throw new UnsafeCodexSocketError(problem);
    return socketAccepts(socketPath);
  };
}

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Pick the endpoint for one spawn of a Codex agent's daemon. The daemon dir is
 * injectable so tests never touch the real /tmp/codex-daemon-<uid>; `lstat` so
 * tests can present another user's directory.
 */
export async function chooseCodexEndpoint(
  agentId: string,
  binary: string,
  configDir = getConfigDir(),
  daemonDir = codexDaemonDir(),
  lstat?: (p: string) => StatLike,
): Promise<SidecarEndpointChoice> {
  if (process.platform === "win32") {
    return { kind: "tcp", reason: "unix sockets aren't used on Windows" };
  }
  // ── compatibility: TCP + notice ──
  const support = await codexSupportsUnixListen(binary);
  if (support === "no") {
    return {
      kind: "tcp",
      reason:
        "the installed Codex doesn't support `app-server --listen unix://`; upgrade Codex",
    };
  }
  if (support === "unknown") {
    // Not cached: the next spawn asks again.
    return {
      kind: "tcp",
      reason:
        "couldn't check whether the installed Codex supports unix sockets (`codex app-server --help` failed or timed out); the next spawn will check again",
    };
  }
  const socketPath = codexSocketPath(agentId, configDir);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return {
      kind: "tcp",
      reason: `the socket path would be ${Buffer.byteLength(socketPath)} bytes (limit ${MAX_SOCKET_PATH_BYTES}); the config dir is too long`,
    };
  }
  // ── hostile: refuse ──
  // Our cx/ lives in the config dir, which is ours; a problem there is still
  // not something to answer with TCP.
  const cxDir = dirname(socketPath);
  const cxProblem = ensurePrivateDir(cxDir);
  if (cxProblem) return { kind: "refuse", reason: cxProblem };
  // Codex creates this itself if absent; creating it first means another user
  // can't have it ready for us.
  const daemonProblem = ensurePrivateDir(daemonDir, lstat);
  if (daemonProblem) {
    const owner = (() => {
      try {
        return ` (owner uid ${(lstat ?? lstatSync)(daemonDir).uid})`;
      } catch {
        return "";
      }
    })();
    return {
      kind: "refuse",
      reason:
        `${daemonProblem}${owner}. Another user may have created it to take ` +
        `over Codex's control socket. An administrator can remove it with ` +
        `\`sudo rm -rf ${daemonDir}\`, then restart the agent.`,
    };
  }
  sweepStaleSockets(agentId, cxDir);
  return { kind: "unix", endpoint: `unix://${socketPath}`, socketPath };
}

/** The notice an operator sees when a Codex agent falls back to TCP. */
export function tcpFallbackNotice(agentName: string, reason: string): string {
  return (
    `${agentName}'s Codex control socket is on loopback TCP, which any user on ` +
    `this machine can connect to and run commands through (${reason}). ` +
    "Restart the agent once that's fixed."
  );
}

/** The notice for a refused Codex spawn (hostile state). */
export function refusedSpawnNotice(agentName: string, reason: string): string {
  return (
    `${agentName} was NOT started: its Codex control socket isn't safe ` +
    `(${reason}). It won't fall back to loopback TCP, which any user on this ` +
    "machine could use to run commands as you."
  );
}

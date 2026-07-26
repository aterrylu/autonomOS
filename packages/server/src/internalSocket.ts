/**
 * Internal control-plane Unix socket — lifecycle helpers (ADR-055).
 *
 * The internal control plane listens on a Unix domain socket instead of a TCP
 * port. As of PR A it carries exactly two things:
 *
 *   - `POST /mcp` (+ GET/DELETE) — the orchestration transport
 *   - `POST /api/hooks/:sessionId` — agent hook ingestion
 *
 * `/ws/gateway` is NOT here: it remains on the PUBLIC token-gated listener
 * (run.ts). ADR-055 plans to move it, but that lands in PR B alongside
 * per-agent gateway identity — do not read this module as evidence that
 * inter-agent traffic is already off the network. It is not.
 *
 * A socket is reachable only by
 * processes running as the server's user on this box — which is exactly what an
 * autonomOS-spawned agent is, and exactly what a network client is not. That
 * makes "only on-box agents may reach the control plane" a property the kernel
 * enforces, rather than an application-layer check we have to keep correct.
 *
 * This module owns the path derivation and the bind/unbind hygiene; run.ts owns
 * the listener itself.
 */

import { chmodSync, statSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";

/** Socket filename inside the config dir. */
export const CONTROL_SOCKET_NAME = "control.sock";

/**
 * Path of the internal control socket — `$configDir/control.sock`.
 *
 * Deriving from getConfigDir() (rather than hardcoding ~/.autonomos) means an
 * AUTONOMOS_CONFIG_DIR-isolated dev/test server automatically gets an isolated
 * socket, so it cannot collide with — or be mistaken for — the live instance.
 */
export function getControlSocketPath(): string {
  return join(getConfigDir(), CONTROL_SOCKET_NAME);
}

/**
 * Reject socket paths the clients can't express.
 *
 * The colon rule is FORWARD DEFENSE for PR B, not a description of today's
 * clients: nothing currently dials a `ws+unix:` URL. When PR B moves the
 * gateway onto this socket, the channel-server will address it as
 * `ws+unix://<socketPath>:/ws/gateway`, and the `ws` client splits that on the
 * FIRST `:` to separate socket path from request path — so a `:` anywhere in
 * the socket path would silently truncate it and the agent would dial a
 * nonexistent socket. Rejecting it at boot now means PR B cannot inherit a
 * config dir that was already quietly incompatible. The guard becomes
 * load-bearing then; today it is cheap insurance.
 *
 * The length cap is the OS limit on `sockaddr_un.sun_path` (~104 bytes on
 * macOS/BSD, 108 on Linux); exceeding it fails bind() with a bare EINVAL.
 *
 * Failing loudly is deliberate — silently relocating the socket somewhere the
 * operator didn't ask for is harder to debug than a clear boot error. Real
 * paths are nowhere near the limit (`~/.autonomos/control.sock` is ~35 bytes;
 * the integ harness's mkdtemp path is ~84 on macOS, ~40 on Linux). If anyone
 * ever hits this in practice, the escape hatch is a short hashed directory
 * (e.g. `/tmp/aos-<hash-of-config-dir>/control.sock`) rather than raising the
 * cap — but that is a future option, not something to build speculatively.
 */
export function assertUsableSocketPath(socketPath: string): void {
  if (socketPath.includes(":")) {
    throw new Error(
      `Internal control socket path contains ":" (${socketPath}) — a colon ` +
        `truncates the path in the ws+unix:// form the gateway will use, so it ` +
        `is rejected up front. Move the config dir (AUTONOMOS_CONFIG_DIR) ` +
        `somewhere without a colon.`,
    );
  }
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength > 100) {
    throw new Error(
      `Internal control socket path is ${byteLength} bytes (${socketPath}) — the OS ` +
        `limit for Unix socket paths is ~104. Use a shorter AUTONOMOS_CONFIG_DIR.`,
    );
  }
}

export type SocketProbe = "absent" | "stale" | "live" | "not-a-socket";

/**
 * Determine whether an existing socket file has a server behind it.
 *
 * Unix sockets are filesystem entries that OUTLIVE the process that bound them:
 * a crash or SIGKILL leaves the file behind, and the next bind() fails
 * EADDRINUSE. So a stale file must be unlinked before listen(). But unlinking
 * unconditionally is how you get two servers fighting over one config dir — the
 * PR #172 failure mode. A file that a live peer is still serving must be left
 * alone.
 *
 * On the normal path acquireOwnership() HAS already run by the time we get here
 * (run.ts binds this socket inside the pid-file "acquired" branch), so the pid
 * file is the primary mutual exclusion and this probe is defence in depth. The
 * case where the probe is the ONLY guard is the degraded branch: when
 * acquireOwnership itself throws (filesystem error), run.ts proceeds anyway, and
 * then a live peer's socket is the sole thing standing between us and its state.
 *
 * connect() distinguishes the two: a live listener accepts, a stale file
 * refuses with ECONNREFUSED.
 */
export function probeControlSocket(socketPath: string): Promise<SocketProbe> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(socketPath);
  } catch {
    return Promise.resolve("absent");
  }

  // Something is at the path but it isn't a socket at all (a stray regular
  // file, a directory). Distinguished from "live" deliberately: connect() to a
  // regular file does NOT return ECONNREFUSED, so folding this case into the
  // liveness check would report "another server is already running" and send
  // an operator hunting a process that does not exist.
  if (!stat.isSocket()) {
    return Promise.resolve("not-a-socket");
  }

  return new Promise<SocketProbe>((resolve) => {
    const sock = connect(socketPath);
    const done = (result: SocketProbe): void => {
      sock.destroy();
      resolve(result);
    };
    sock.once("connect", () => done("live"));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED — the file exists but nothing is accepting: stale.
      // Anything else (EACCES, ENOTSOCK, EPERM) means we should NOT delete a
      // file we don't understand; treat it as live so bind fails loudly.
      done(err.code === "ECONNREFUSED" ? "stale" : "live");
    });
    // A socket that accepts the connection but never completes is not something
    // we should race on; bound the probe.
    sock.setTimeout(2000, () => done("live"));
  });
}

/**
 * Make `socketPath` bindable, or throw explaining why it isn't.
 * Unlinks a stale socket file; refuses to touch one a live server owns.
 */
export async function prepareControlSocket(socketPath: string): Promise<void> {
  const probe = await probeControlSocket(socketPath);

  if (probe === "live") {
    throw new Error(
      `Another autonomos-server is already serving the internal control socket at ` +
        `${socketPath}. Refusing to take it over — stop that server first ` +
        `(\`autonomos stop\`), or use a separate AUTONOMOS_CONFIG_DIR.`,
    );
  }

  if (probe === "not-a-socket") {
    throw new Error(
      `${socketPath} exists but is not a socket. Something other than ` +
        `autonomos-server created it; refusing to delete a file we did not ` +
        `make. Inspect and remove it by hand, then restart.`,
    );
  }

  if (probe === "stale") {
    unlinkSync(socketPath);
    console.warn(
      `[internal] removed stale control socket at ${socketPath} ` +
        `(left behind by a server that did not shut down cleanly)`,
    );
  }
}

/**
 * Restrict the bound socket to the owning user.
 *
 * NOTE for review: there is a narrow window between bind() and this chmod where
 * the socket carries the process umask's mode (typically 0755 → world-connectable).
 * Closing it fully would mean either a process-global umask flip around bind
 * (racy against concurrent file creation at boot) or enforcing 0700 on the
 * config dir itself (mutates a directory the user owns). Given the window is
 * sub-millisecond and requires a local attacker already polling for it, this
 * chmod plus the config dir's own permissions is the chosen tradeoff.
 */
export function restrictControlSocket(socketPath: string): void {
  chmodSync(socketPath, 0o600);
}

/** Remove the socket file on shutdown. Best effort — never blocks exit. */
export function removeControlSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[internal] could not remove control socket ${socketPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

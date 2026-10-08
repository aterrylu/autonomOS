import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where `tailscale serve --bg unix:<path>` connects (ADR-153).
 *
 * The socket is owner-only (0600) so that only tailscaled can present the
 * identity headers autonomOS then trusts. Who "tailscaled" is decides where
 * the socket may live (measured 2026-10-08, Tailscale 1.102.3):
 *  - Linux, and macOS with the standalone daemon: tailscaled runs as root and
 *    can connect anywhere → the config dir (0700).
 *  - macOS App Store build: the proxy runs in the SANDBOXED IPNExtension as
 *    the operator. A socket in /tmp gave 502; one inside its app-group
 *    container (~/Library/Group Containers/<team>.group.io.tailscale.ipn.macos,
 *    a 0700 dir the operator owns) gave 200. So the socket goes there.
 * `--serve-socket=<path>` overrides either.
 */

/** Unix socket paths cap at ~104 bytes on macOS (108 on Linux). */
export const MAX_SOCKET_PATH_BYTES = 103;

const TAILSCALE_GROUP_CONTAINER = /\.group\.io\.tailscale\.ipn\.macos$/;

/** The App Store Tailscale's app-group container, if this Mac has one. */
export function tailscaleGroupContainer(
  home = homedir(),
  list: (dir: string) => string[] = (d) => readdirSync(d),
): string | undefined {
  const dir = join(home, "Library", "Group Containers");
  try {
    const hit = list(dir).find((n) => TAILSCALE_GROUP_CONTAINER.test(n));
    return hit ? join(dir, hit) : undefined;
  } catch {
    return undefined;
  }
}

export function defaultServeSocketPath(o: {
  configDir: string;
  port: number;
  platform?: NodeJS.Platform;
  groupContainer?: () => string | undefined;
}): string {
  const platform = o.platform ?? process.platform;
  if (platform === "darwin") {
    const container = (o.groupContainer ?? tailscaleGroupContainer)();
    // One file per port, so two autonomOS instances never share a socket.
    if (container) return join(container, `aos-${o.port}.sock`);
  }
  return join(o.configDir, "serve.sock");
}

/** Refuse a path the OS can't bind, saying what to do about it. */
export function assertServeSocketPath(path: string): void {
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(
      `The tailscale serve socket path is ${bytes} bytes (${path}); the OS limit is about ${MAX_SOCKET_PATH_BYTES}. Pass a shorter one with --serve-socket=<path> (AUTONOMOS_SERVE_SOCKET).`,
    );
}

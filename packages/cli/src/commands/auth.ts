// `autonomos auth unlock` — reopen sign-in for new devices (ADR-148).
//
// With a short operator token, the server locks out NEW devices after a fixed
// number of failed sign-ins, so an attacker's total chance is capped instead
// of growing with time. Devices that have already signed in, and this machine,
// are never locked. This verb is the operator's way to reopen it:
//   - server running → asks it over loopback (always allowed), with the token
//     this machine already holds;
//   - server stopped → clears the persisted lock in the config dir.
//
// Exit codes: 0 unlocked · 1 failed · 64 usage.

import { peekAuthToken } from "@autonomos/server/auth.js";
import { getConfigDir } from "@autonomos/server/configDir.js";
import {
  loadState,
  newDeviceLockPath,
  unlockOnDisk,
} from "@autonomos/server/newDeviceLock.js";
import { isPidAlive, readPidFile } from "@autonomos/server/pid-file.js";

const USAGE = `Usage: autonomos auth unlock

  unlock    Let new devices sign in again after the server locked them out
            for repeated failed sign-ins
`;

export async function runAuthCommand(argv: readonly string[]): Promise<number> {
  if (argv[0] !== "unlock" || argv.length > 1) {
    process.stderr.write(USAGE);
    return 64;
  }
  const path = newDeviceLockPath(getConfigDir());
  const pid = readPidFile();
  if (pid && isPidAlive(pid.pid)) {
    const found = peekAuthToken();
    if (!found) {
      console.error("✖ No operator token found on this machine.");
      return 1;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${pid.port}/api/auth/unlock`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${found.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!res.ok) {
        console.error(`✖ The server refused the unlock (HTTP ${res.status}).`);
        return 1;
      }
    } catch (err) {
      console.error(
        `✖ Couldn't reach the server on port ${pid.port}: ${err instanceof Error ? err.message : err}`,
      );
      return 1;
    }
    console.log("✓ New devices can sign in again.");
    return 0;
  }
  const before = loadState(path);
  unlockOnDisk(path);
  console.log(
    before.lockedAt !== null
      ? "✓ New devices can sign in again (applied to the saved state; the server isn't running)."
      : "✓ New devices weren't locked out.",
  );
  return 0;
}

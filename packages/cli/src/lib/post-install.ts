// Post-install verification + "connect" panel.
//
// After install-service activates the daemon, this polls until it is actually
// responsive (the smoke test that replaces the old "should be running shortly"
// guess), then prints where to reach it — the dashboard URL, the auth token,
// and a click-to-auth link — and optionally opens a browser.
//
// Sources of truth, read AFTER the daemon boots (so they're populated):
//   - port  → the pid file ($configDir/autonomos.pid), since a default install
//             binds :3000 while `make prod` forces :3100 — never assume.
//   - token → $configDir/token, which the server writes on first boot.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "@autonomos/server/configDir.js";
import {
  isPidAlive,
  isPortResponsive,
  readPidFile,
} from "@autonomos/server/pid-file.js";

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readTokenFile(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf-8").trim() || null;
  } catch (err) {
    // The file exists but we couldn't read it — surface it rather than letting
    // the panel falsely claim "configured via AUTONOMOS_TOKEN".
    console.warn(
      `⚠️  Couldn't read the token file (${file}): ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

function readToken(): string | null {
  const local = readTokenFile(join(getConfigDir(), "token"));
  if (local) return local;
  // Mirror resolveAuthToken()'s legacy fallback: a non-default config dir with
  // no local token resolves against ~/.autonomos/token.
  const home = process.env.HOME;
  if (home) {
    const fallback = join(home, ".autonomos", "token");
    if (fallback !== join(getConfigDir(), "token")) {
      return readTokenFile(fallback);
    }
  }
  return null;
}

// Best-effort open in the default browser. Silently no-ops where it can't or
// shouldn't run (CI, a headless Linux box with no display, or no opener binary).
function openBrowser(url: string): void {
  if (process.env.CI) return;
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    return; // headless server — opening a browser is meaningless
  }
  try {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {}); // no opener installed → ignore
    child.unref();
  } catch {
    // never let opening a browser fail the install
  }
}

/**
 * Poll for the freshly-installed daemon to come up, then print the connect
 * panel. Never throws — the service file is already written either way. Returns
 * `true` if the daemon became responsive, `false` on timeout (so the caller can
 * make the exit code honest instead of printing a success banner over a down
 * daemon).
 */
export async function verifyAndReportInstall(
  opts: { open: boolean },
  cfg: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = cfg.timeoutMs ?? TIMEOUT_MS;
  const pollMs = cfg.pollMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let owner: ReturnType<typeof readPidFile> = null;
  for (;;) {
    const p = readPidFile();
    if (p && isPidAlive(p.pid) && (await isPortResponsive(p.port))) {
      owner = p;
      break;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  if (!owner) {
    console.warn("");
    console.warn(
      "⚠️  The daemon didn't become responsive within " +
        `${Math.round(timeoutMs / 1000)}s.`,
    );
    console.warn("    Check:  autonomos status   and   autonomos logs");
    return false;
  }

  const url = `http://localhost:${owner.port}`;
  const token = readToken();
  const authUrl = token ? `${url}/auth?token=${token}` : url;

  console.log("");
  console.log("  ✓ autonomOS is running.");
  console.log(`    Dashboard:  ${url}`);
  if (token) {
    console.log(`    Token:      ${token}`);
    console.log(`    Open:       ${authUrl}`);
  } else {
    console.log("    Token:      (configured via AUTONOMOS_TOKEN)");
  }
  console.log(
    "    Manage:     autonomos status · autonomos logs -f · autonomos restart",
  );
  console.log("");

  if (opts.open) openBrowser(authUrl);
  return true;
}

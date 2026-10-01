// Suite-wide guard: no test may change the permissions of the operator's REAL
// home or its sensitive folders.
//
// Loaded into every test file's process (`--import`, see the Makefile's test
// line). It records the modes of the real home, read from the password
// database (`os.userInfo()`) so a test that repoints $HOME can't hide it, and
// of a few folders under it. When the process exits, any change fails that
// test file and names the path.
//
// Why: on 2026-09-30 a mutation test removed a "never chmod a home" guard
// while its unit test called the guarded function on the real homedir(), and
// the operator's ~ went 0750 → 0700. Tests isolate HOME by convention
// (isolate-home.ts). This makes a slip loud instead of silent.
//
// AUTONOMOS_HOME_SENTINEL_PATHS (comma-separated) replaces the watch list.
// It is only for this guard's own test, which must never touch real paths.

import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

function watchedPaths(): string[] {
  const override = process.env.AUTONOMOS_HOME_SENTINEL_PATHS;
  if (override) return override.split(",").filter(Boolean);
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    return []; // no passwd entry (some containers): nothing to guard
  }
  return [
    home,
    ...[".autonomos", ".claude", ".codex", ".gemini", ".ssh"].map((d) =>
      join(home, d),
    ),
  ];
}

function modeOf(path: string): number | null {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return null; // absent: only a change of state matters
  }
}

const watched = watchedPaths();
const before = new Map(watched.map((p) => [p, modeOf(p)]));

process.on("exit", () => {
  for (const path of watched) {
    const was = before.get(path) ?? null;
    // Only folders that existed at the start: the guarded failure is a test
    // changing the operator's permissions. (A tool creating ~/.codex on a fresh
    // CI runner is not that, and must not fail the suite.)
    if (was === null) continue;
    const now = modeOf(path);
    if (was === now) continue;
    const fmt = (m: number | null) => (m === null ? "absent" : m.toString(8));
    process.stderr.write(
      `\n[home-sentinel] a test changed ${path}: ${fmt(was)} → ${fmt(now)}. Tests must use a throwaway HOME (helpers/isolate-home.ts), never the operator's real one.\n`,
    );
    process.exitCode = 1;
  }
});

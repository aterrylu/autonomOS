/**
 * Shared config directory — ~/.autonomos/
 *
 * All modules that persist data (settings, sessions) should use these
 * helpers instead of duplicating the HOME / mkdir logic.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  type Stats,
  statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");

/**
 * Config directory — defaults to ~/.autonomos/, overridable via AUTONOMOS_CONFIG_DIR.
 * The override is used by `make dev` in worktrees to isolate dev instances.
 */
const DEFAULT_CONFIG_DIR = join(HOME, ".autonomos");

export const CONFIG_DIR =
  process.env.AUTONOMOS_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR;

/** Test-process detection for the escape guard. NODE_TEST_CONTEXT covers the
 *  default child-process runner; the extra signals close the fail-open paths
 *  a dev actually hits (running one file directly — node:test auto-runs on
 *  import with no env marker — and `--test` with isolation=none). Belt over
 *  belt on purpose: this guard is the load-bearing part of the fixture-escape
 *  fix, and fail-open here is how a "killed" class recurs. */
export function runningUnderTestRunner(): boolean {
  if (process.env.NODE_TEST_CONTEXT) return true;
  if (process.execArgv.includes("--test") || process.argv.includes("--test"))
    return true;
  const entry = process.argv[1] ?? "";
  return /\.test\.[cm]?[tj]s$/.test(entry);
}

let _testOverride: string | null = null;

/** Returns the active config dir — test override if set, otherwise CONFIG_DIR. */
export function getConfigDir(): string {
  if (_testOverride) return _testOverride;
  // TEST-ESCAPE GUARD: a test process must NEVER resolve the production
  // config dir — that is how a fixture (status:"running", bypass-mode)
  // escaped into ~/.autonomos and was resurrected as a live agent by the
  // next upgrade's boot-resume. NODE_TEST_CONTEXT is set by `node --test` /
  // `tsx --test` in every test process. Crucially the check compares the
  // RESOLVED dir against the real default, not "is the env var set":
  // autonomOS sets AUTONOMOS_CONFIG_DIR=<real dir> in every spawned agent's
  // env, so a worker running the suite inherits an explicitly-set var that
  // STILL points at production — presence is not isolation. Env is read
  // LIVE (not the module-load snapshot) so suites that set an isolated dir
  // in a before-hook pass.
  const resolved =
    process.env.AUTONOMOS_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR;
  if (runningUnderTestRunner() && resolved === DEFAULT_CONFIG_DIR) {
    throw new Error(
      "Test resolved the REAL config dir (~/.autonomos). Tests must isolate: " +
        "set AUTONOMOS_CONFIG_DIR to a temp dir before importing persistence " +
        "modules, or call _setConfigDirForTesting(mkdtemp(...)). Refusing to " +
        "read/write production agent state from a test process.",
    );
  }
  return resolved;
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    // 0700: the config root holds the auth token, agent records, schedules and
    // templates. Owner-only. Creation-time only (an existing dir keeps its
    // mode — the token file inside is 0600 regardless).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Re-apply owner-only modes to what an OLDER build created loose (V8).
 *
 * Before #301 the config root was created 0755, and the log file, schedule-run
 * history and env-presets dir used the process umask (typically 0644/0755). The
 * log can carry the operator token (the old banner showed short tokens whole),
 * so on a multi-user host another account could read it. Creation-time modes
 * never reached those installs, so this runs on every boot.
 *
 * Only ever REMOVES group/other bits (`mode & ~0o077`). The owner's access is
 * unchanged, so nothing that authenticates today can stop working: tightening
 * never breaks auth. Skips anything not owned by this uid and symlinks. Refuses
 * outright to touch `/`, a home directory or any ANCESTOR of one, compared by
 * filesystem identity so a case variant or a symlinked parent can't sneak past
 * (see isProtectedDir). Touches the root only when it is recognisably an
 * autonomOS config dir (the default path, or one already holding its files),
 * so a directory named by mistake before the server ever wrote to it is left
 * alone. Once it holds the token it IS the config dir, and it is tightened.
 * Never throws. Returns the paths it changed, for one boot log line.
 */
export function tightenConfigDirModes(
  dir: string = getConfigDir(),
  homes: readonly string[] = currentHomes(),
): string[] {
  const changed: string[] = [];
  const uid = process.getuid?.();
  const tighten = (p: string): boolean => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return false;
      if (uid !== undefined && st.uid !== uid) return false;
      const perm = st.mode & 0o777;
      if ((perm & 0o077) === 0) return st.isDirectory();
      chmodSync(p, perm & ~0o077);
      changed.push(p);
      return st.isDirectory();
    } catch {
      return false;
    }
  };
  const root = resolve(dir);
  if (isProtectedDir(root, homes)) return changed;
  if (!isAutonomosConfigDir(root)) return changed;
  if (!tighten(root)) return changed;
  // The files that can carry a secret or prompt text, one level deep each.
  for (const sub of ["logs", "schedule-runs", "env-presets", "agent-tokens"]) {
    const d = join(root, sub);
    if (!existsSync(d) || !tighten(d)) continue;
    try {
      for (const name of readdirSync(d)) tighten(join(d, name));
    } catch {
      // unreadable: leave it
    }
  }
  for (const name of ["token", "autonomos.pid"]) {
    const f = join(root, name);
    if (existsSync(f)) tighten(f);
  }
  return changed;
}

/** Files only an autonomOS config dir holds. */
const CONFIG_DIR_MARKERS = [
  "token",
  "autonomos.pid",
  "settings.json",
  "agents",
  "logs",
];

function isAutonomosConfigDir(root: string): boolean {
  if (!existsSync(root)) return false;
  if (root === resolve(DEFAULT_CONFIG_DIR)) return true;
  return CONFIG_DIR_MARKERS.some((m) => existsSync(join(root, m)));
}

/**
 * Directories tightenConfigDirModes must never chmod: `/`, each home, and
 * every ancestor of a home (chmod-ing `/Users` would lock everyone out of
 * theirs).
 *
 * Two checks. The path check is pure (made-up paths in tests). The IDENTITY
 * check compares the target's (dev, ino) with each home's and each of its
 * ancestors', following symlinks. String comparison alone missed a case
 * variant on a case-insensitive volume (`/users/ALICE`) and a home reached
 * through a symlinked parent (SecurityAudit, #449). `stat` is injectable for
 * the tests.
 */
export function isProtectedDir(
  dir: string,
  homes: readonly string[],
  stat: (p: string) => Pick<Stats, "dev" | "ino"> = statSync,
): boolean {
  const root = resolve(dir);
  if (root === resolve("/")) return true;
  if (pathIsHomeOrAncestor(root, homes)) return true;
  let target: string;
  try {
    const st = stat(root);
    target = `${st.dev}:${st.ino}`;
  } catch {
    return false; // nothing there: nothing to chmod
  }
  for (const h of homes) {
    let p = resolve(h);
    for (;;) {
      try {
        const st = stat(p);
        if (`${st.dev}:${st.ino}` === target) return true;
      } catch {
        // a missing ancestor can't be the target
      }
      const up = dirname(p);
      if (up === p) break;
      p = up;
    }
  }
  return false;
}

function pathIsHomeOrAncestor(root: string, homes: readonly string[]): boolean {
  return homes.some((h) => {
    const home = resolve(h);
    return (
      home === root || home.startsWith(root.endsWith(sep) ? root : root + sep)
    );
  });
}

/** $HOME AND the account's real home (os.userInfo reads the password
 *  database, so a spoofed $HOME can't hide it). */
function currentHomes(): string[] {
  const homes = [homedir()];
  try {
    homes.push(userInfo().homedir);
  } catch {
    // no passwd entry (some containers): $HOME alone
  }
  return homes;
}

/** For testing — redirect all config reads to an isolated temp directory. */
export function _setConfigDirForTesting(dir: string): void {
  _testOverride = dir;
}

/** For testing — restore default config dir. */
export function _resetConfigDirForTesting(): void {
  _testOverride = null;
}

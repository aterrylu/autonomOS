import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimum versions of dependencies with a security fix we rely on (security
 * audit V12/V12b). Adding a floor is one line here; the lockfile guard
 * (security-floors.test.ts) and the installed-tree check below both read it.
 *
 * `seenBy` lists the packages that load the dependency at runtime, as Node
 * resolves it FROM each of them. That is the version that matters: bun keeps a
 * per-parent nested copy whenever a parent's range allows it, so our own
 * package.json can say ws ^8.22 while @hono/node-ws, which builds every
 * WebSocketServer we accept connections on, still loads 8.19. "." is
 * packages/server itself.
 */
export type SecurityFloor = {
  pkg: string;
  min: string;
  why: string;
  seenBy: readonly string[];
};

export const SECURITY_FLOORS: readonly SecurityFloor[] = [
  {
    pkg: "ws",
    min: "8.21.1",
    why: "a message split into a flood of empty fragments exhausts memory",
    seenBy: [".", "@hono/node-ws"],
  },
  {
    pkg: "hono",
    min: "4.13.12",
    why: "a long CORS preflight header blocks the event loop (ReDoS)",
    seenBy: [
      ".",
      "@hono/node-server",
      "@hono/node-ws",
      "@modelcontextprotocol/sdk",
    ],
  },
];

/** -1 / 0 / 1 for dotted numeric versions; a pre-release tag is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type LockFloorProblem = {
  pkg: string;
  min: string;
  /** Every version of `pkg` the lockfile pins, with the key that pins it. */
  entries: { key: string; version: string }[];
  reason: "below-floor" | "multiple-copies" | "missing";
};

/**
 * Check a bun.lock against the floors: each floored package must be pinned
 * exactly ONCE, at or above its floor. A second (nested) entry is refused even
 * when it's above the floor today, because it's the shape that left a stale
 * copy behind after V12 and V12b.
 */
export function checkLockfileFloors(
  lockText: string,
  floors: readonly SecurityFloor[] = SECURITY_FLOORS,
): LockFloorProblem[] {
  // Package entries look like:   "@hono/node-ws/ws": ["ws@8.19.0", "", ...
  const entry = /^\s{4}"([^"]+)": \["((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/;
  const pinned = new Map<string, { key: string; version: string }[]>();
  for (const line of lockText.split("\n")) {
    const m = entry.exec(line);
    if (!m) continue;
    const [, key, name, version] = m;
    const list = pinned.get(name) ?? [];
    list.push({ key, version });
    pinned.set(name, list);
  }
  const problems: LockFloorProblem[] = [];
  for (const f of floors) {
    const entries = pinned.get(f.pkg) ?? [];
    const base = { pkg: f.pkg, min: f.min, entries };
    if (entries.length === 0) problems.push({ ...base, reason: "missing" });
    else if (entries.some((e) => compareVersions(e.version, f.min) < 0))
      problems.push({ ...base, reason: "below-floor" });
    else if (entries.length > 1)
      problems.push({ ...base, reason: "multiple-copies" });
  }
  return problems;
}

/**
 * Where Node finds `pkg` when `fromDir` requires it: the nearest ancestor's
 * node_modules/<pkg>, skipping ancestors that are themselves node_modules.
 * Reading package.json directly avoids `exports` maps that don't export it.
 * Returns the package's real directory, or null.
 */
function resolvePackageDir(fromDir: string, pkg: string): string | null {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", pkg);
      if (existsSync(join(candidate, "package.json"))) {
        return realpathSync(candidate);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type InstalledFloorViolation = {
  pkg: string;
  min: string;
  why: string;
  /** "below-floor": the version loaded is too old. "unverified": the package
   *  (or the consumer that loads it) didn't resolve, so nothing proves the
   *  version, and a check that can't see is not a pass. */
  problem: "below-floor" | "unverified";
  /** The version loaded, or null when unverified. */
  version: string | null;
  seenBy: string;
};

/**
 * Check the INSTALLED tree: every floored package, as resolved from each of
 * its runtime consumers, must be at or above its floor. Returns null only
 * when `serverDir` isn't the @autonomos/server package: a bundle install,
 * whose deps were inlined at release-build time from a fresh install, so
 * there is no tree to check. Inside a source tree, a consumer or package
 * that doesn't resolve is reported as "unverified", never skipped: skipping
 * it would turn "couldn't look" into a pass for exactly the nested copy this
 * check exists for. `seenBy` is maintained by hand; the bun.lock one-copy
 * guard is the backstop for a consumer it doesn't list.
 */
export function checkInstalledFloors(
  serverDir: string = defaultServerDir(),
  floors: readonly SecurityFloor[] = SECURITY_FLOORS,
): InstalledFloorViolation[] | null {
  if (!isServerPackage(serverDir)) return null;
  const root = realpathSync(serverDir);
  const violations: InstalledFloorViolation[] = [];
  for (const f of floors) {
    for (const consumer of f.seenBy) {
      const seenBy = consumer === "." ? "@autonomos/server" : consumer;
      const base = { pkg: f.pkg, min: f.min, why: f.why, seenBy };
      const from = consumer === "." ? root : resolvePackageDir(root, consumer);
      const dir = from ? resolvePackageDir(from, f.pkg) : null;
      if (!dir) {
        violations.push({ ...base, problem: "unverified", version: null });
        continue;
      }
      const { version } = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { version: string };
      if (compareVersions(version, f.min) < 0) {
        violations.push({ ...base, problem: "below-floor", version });
      }
    }
  }
  return violations;
}

function isServerPackage(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg?.name === "@autonomos/server";
  } catch {
    return false;
  }
}

/** packages/server, from this module's own location (src/ or a build dir). */
export function defaultServerDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The command that relinks a tree to exactly what bun.lock says. --force
 *  relinks nested copies a plain install keeps; --frozen-lockfile stops
 *  --force ("always request the latest versions") from re-resolving with the
 *  operator's bun. */
export const RELINK_COMMAND = [
  "bun",
  "install",
  "--force",
  "--frozen-lockfile",
] as const;

/** The operator-facing explanation, one problem per line plus the fix. */
export function formatFloorViolations(
  violations: InstalledFloorViolation[],
  repoRoot: string,
): string {
  const lines = violations.map((v) =>
    v.problem === "unverified"
      ? `  couldn't verify ${v.pkg} as loaded by ${v.seenBy} (not installed where Node would look); it must be ${v.min} or later: ${v.why}`
      : `  ${v.pkg} ${v.version} (loaded by ${v.seenBy}) is below ${v.min}: ${v.why}`,
  );
  return [
    "SECURITY: installed dependencies don't meet this version's security floors:",
    ...lines,
    `  Fix: cd ${repoRoot} && ${RELINK_COMMAND.join(" ")}, then restart autonomOS.`,
  ].join("\n");
}

/**
 * The build-time repair (`make build`): check the tree; only when a floor is
 * violated or unverified, relink once and check again. Conditional on
 * purpose: --force contacts the registry even with a warm cache (measured: a
 * plain frozen install offline finishes in 0.3 s, --force hangs), so an
 * unconditional --force would hang every offline build of a healthy tree.
 * Returns the problems left after the repair (empty = OK), or null when there
 * is no tree to check.
 */
export function ensureSecurityFloors(deps: {
  check: () => InstalledFloorViolation[] | null;
  relink: () => { ok: boolean; detail: string };
  log: (line: string) => void;
}): InstalledFloorViolation[] | null {
  const before = deps.check();
  if (!before?.length) return before;
  deps.log(
    `[security-floors] ${before.length} problem(s) in the installed tree; relinking with: ${RELINK_COMMAND.join(" ")}`,
  );
  const relink = deps.relink();
  if (!relink.ok) deps.log(`[security-floors] relink failed: ${relink.detail}`);
  return deps.check();
}

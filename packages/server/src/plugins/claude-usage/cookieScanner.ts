/**
 * Discover the *current* Claude session key by reading the environment of the
 * user's running interactive Claude Code sessions.
 *
 * Why this exists: Claude Code injects `CLAUDE_SESSION_COOKIE` into the
 * processes it spawns, but it only *propagates* an inherited value — it never
 * re-derives the cookie from the logged-in account (verified empirically: strip
 * the var from a fresh `claude`'s env and no hook ever sees it, yet the session
 * still authenticates, via OAuth). So the cookie a long-running autonomOS server
 * holds in its own env is frozen at launch and goes stale the moment the user
 * logs into a different Claude account. The agents the server spawns — and any
 * other child it spawns (e.g. scheduler `isolated` runs) — inherit that same
 * frozen value, so they can't surface a newer one either.
 *
 * The only place a freshly-logged-in account's cookie appears is in the
 * *interactive* `claude` sessions the user starts from their own terminal —
 * separate process trees that are NOT descendants of the server. This module
 * reads `CLAUDE_SESSION_COOKIE` from those external sessions and adopts the most
 * recently started one, so usage tracking follows an account switch with no
 * restart and no manual paste.
 *
 * Deliberate constraints:
 *   - The fix must not depend on the *server itself* having a cookie. A
 *     `make prod`/launchd install with no Claude Code ancestry has none; the
 *     scan finds the user's interactive sessions instead.
 *   - The server's own process tree is excluded — by process ancestry (anything
 *     descending from this server PID) AND by `AUTONOMOS_*` env markers. Both,
 *     because ancestry breaks if an intermediate parent dies (reparented to
 *     init) while the inherited env marker survives, and the marker is absent on
 *     non-agent children like scheduler runs. Together they reliably keep the
 *     frozen server cookie out of the candidate set.
 *   - Only the current user's own process environments are read (`ps` on macOS,
 *     `/proc` on Linux), where the cookie already lives. The value is validated
 *     against the strict session-key shape and never logged.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { isValidHarvestedKey, setHarvestedSessionKey } from "./sessionStore.js";

const execFileAsync = promisify(execFile);

/** A running process carrying a Claude session cookie, distilled. */
export interface ClaudeProcInfo {
  pid: number;
  /** Process start time in epoch ms (0 if unknown). Newer = more likely the
   * account the user just switched to. */
  startMs: number;
  /** `CLAUDE_SESSION_COOKIE` from the process env, or null when absent. */
  cookie: string | null;
  /** True when this belongs to the autonomOS server's own process tree (the
   * server, spawned agents, scheduler runs, …) — those only ever hold the
   * frozen launch cookie and must be ignored. */
  hosted: boolean;
}

/** Lists the user's running cookie-bearing processes. Injectable for tests. */
export type ClaudeProcLister = () => Promise<ClaudeProcInfo[]>;

/**
 * Pick the session cookie of the most-recently-started *external* (non-hosted)
 * process carrying a valid key. Pure — exported for tests.
 *
 * Hosted processes are dropped even when newer, because they only ever carry the
 * frozen server cookie; among the user's own sessions, the newest start time is
 * the best signal for "the account just switched to".
 */
export function selectFreshestExternalCookie(
  procs: ClaudeProcInfo[],
): string | null {
  const candidates = procs.filter(
    (p): p is ClaudeProcInfo & { cookie: string } =>
      !p.hosted && !!p.cookie && isValidHarvestedKey(p.cookie),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.startMs - a.startMs);
  return candidates[0].cookie;
}

const COOKIE_PREFIX = "CLAUDE_SESSION_COOKIE=";
const COOKIE_RE = /CLAUDE_SESSION_COOKIE=(\S+)/;
const HOSTED_RE = /AUTONOMOS_(?:AGENT_NAME|SESSION_ID)=/;

/**
 * Walk a process's parent chain to decide whether it descends from (or is) the
 * server. Pure — exported for tests. Depth-capped and cycle-guarded so a
 * malformed ppid map can't loop. A chain that reparents to init (ppid ≤ 1)
 * before reaching the server is treated as external — the env-marker check is
 * the backstop for that case.
 */
export function isServerTree(
  pid: number,
  ppidOf: Map<number, number>,
  serverPid: number,
): boolean {
  let cur = pid;
  for (let depth = 0; depth < 64; depth++) {
    if (cur === serverPid) return true;
    const parent = ppidOf.get(cur);
    if (parent === undefined || parent <= 1 || parent === cur) return false;
    cur = parent;
  }
  return false;
}

/**
 * Extract the cookie + the env-marker `hosted` flag from one process's
 * command+env blob, or null when it carries no session cookie (the only
 * processes we care about). Pure — exported for tests. Cookie values never
 * contain whitespace, so a `\S+` match is safe even though other env values
 * might. Ancestry-based `hosted` is layered on top by the listers.
 */
export function parseProcEnv(
  pid: number,
  startMs: number,
  commandAndEnv: string,
): ClaudeProcInfo | null {
  const ck = commandAndEnv.match(COOKIE_RE);
  if (!ck) return null;
  return {
    pid,
    startMs,
    cookie: ck[1],
    hosted: HOSTED_RE.test(commandAndEnv),
  };
}

/**
 * macOS: one `ps` call lists the current user's processes with their env
 * appended. `x` includes processes without a controlling tty; the absence of
 * `-a` keeps it scoped to the current user (so other users' env stays hidden);
 * `e` appends the environment; `ww` removes the width limit.
 */
async function listDarwin(serverPid: number): Promise<ClaudeProcInfo[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["xeww", "-o", "pid=,ppid=,lstart=,command="],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  // First pass: full pid→ppid map (needed to walk ancestry through processes
  // that don't themselves carry a cookie).
  const ppidOf = new Map<number, number>();
  const rows: Array<{ pid: number; startMs: number; rest: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const t = line.trim().split(/\s+/);
    const pid = Number(t[0]);
    const ppid = Number(t[1]);
    if (!Number.isFinite(pid)) continue;
    if (Number.isFinite(ppid)) ppidOf.set(pid, ppid);
    // lstart is a fixed 5-token timestamp: "Day Mon DD HH:MM:SS YYYY".
    const startMs = Date.parse(t.slice(2, 7).join(" ")) || 0;
    rows.push({ pid, startMs, rest: t.slice(7).join(" ") });
  }
  const out: ClaudeProcInfo[] = [];
  for (const { pid, startMs, rest } of rows) {
    const info = parseProcEnv(pid, startMs, rest);
    if (!info) continue;
    if (!info.hosted) info.hosted = isServerTree(pid, ppidOf, serverPid);
    out.push(info);
  }
  return out;
}

/**
 * Parse `comm` (executable name) and parent PID from a `/proc/<pid>/stat` line.
 * `comm` is wrapped in parens and may itself contain spaces/parens, so it's read
 * between the first '(' and the LAST ')'; the remaining space-separated fields
 * after that are `state ppid …`, so ppid is the 2nd. Exported for tests.
 */
export function parseStat(statText: string): {
  comm: string;
  ppid: number | undefined;
} {
  const open = statText.indexOf("(");
  const close = statText.lastIndexOf(")");
  const comm = open >= 0 && close > open ? statText.slice(open + 1, close) : "";
  const ppid = Number(statText.slice(close + 2).split(" ")[1]);
  return { comm, ppid: Number.isFinite(ppid) ? ppid : undefined };
}

/**
 * Linux: read `/proc` for the current user's processes. Files for other users'
 * processes aren't readable, so they're naturally skipped.
 *
 * One `stat` read per process gives BOTH the parent PID (for the ancestry map,
 * needed for every process to walk chains) AND `comm` — so the much larger
 * `environ` is read ONLY for actual `claude` processes (where a session cookie
 * lives), not for every process on the box. That keeps a usage poll from
 * bursting hundreds of `environ` reads, which on a busy server would add I/O
 * pressure to agent spawns. The proc dir ctime approximates the start time.
 */
async function listLinux(serverPid: number): Promise<ClaudeProcInfo[]> {
  let entries: string[];
  try {
    entries = (await readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  const ppidOf = new Map<number, number>();
  const claudePids: number[] = [];
  await Promise.all(
    entries.map(async (pidStr) => {
      try {
        const { comm, ppid } = parseStat(
          await readFile(`/proc/${pidStr}/stat`, "utf8"),
        );
        const pid = Number(pidStr);
        if (ppid !== undefined) ppidOf.set(pid, ppid);
        // `comm` is truncated to 15 chars; the claude binary reports "claude".
        if (comm.includes("claude")) claudePids.push(pid);
      } catch {
        /* process gone or stat unreadable */
      }
    }),
  );
  const candidates: ClaudeProcInfo[] = [];
  await Promise.all(
    claudePids.map(async (pid) => {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, "utf8");
        const env = environ.split("\0");
        const cookieVar = env.find((e) => e.startsWith(COOKIE_PREFIX));
        if (!cookieVar) return;
        const hosted =
          env.some(
            (e) =>
              e.startsWith("AUTONOMOS_AGENT_NAME=") ||
              e.startsWith("AUTONOMOS_SESSION_ID="),
          ) || isServerTree(pid, ppidOf, serverPid);
        let startMs = 0;
        try {
          startMs = (await stat(`/proc/${pid}`)).ctimeMs;
        } catch {
          /* process may have exited; leave startMs at 0 */
        }
        candidates.push({
          pid,
          startMs,
          cookie: cookieVar.slice(COOKIE_PREFIX.length),
          hosted,
        });
      } catch {
        /* process gone or environ unreadable — skip */
      }
    }),
  );
  return candidates;
}

function defaultLister(): Promise<ClaudeProcInfo[]> {
  if (process.platform === "darwin") return listDarwin(process.pid);
  if (process.platform === "linux") return listLinux(process.pid);
  return Promise.resolve([]);
}

// Test seam: lets a suite replace the real `ps`/`/proc` lister so exercising
// getRateLimits never depends on the host's live Claude sessions. Mirrors
// scanner.ts's setUsageOverride. null = use the real lister.
let listerOverride: ClaudeProcLister | null = null;

/** Inject a fake process lister (tests), or null to restore the real one. */
export function __setProcListerForTests(lister: ClaudeProcLister | null): void {
  listerOverride = lister;
}

// Scanning shells out to `ps`/`/proc`, so it's throttled and de-duplicated to
// stay cheap on the hot usage-fetch path. The dashboard polls usage on an
// interval; one scan per few seconds is plenty to catch an account switch.
const SCAN_THROTTLE_MS = 5_000;
// -Infinity so the very first scan always runs (any `now` is past the window),
// regardless of clock magnitude.
let lastScanMs = Number.NEGATIVE_INFINITY;
let inflight: Promise<boolean> | null = null;
// Throttle the diagnostic for a persistently-failing scan so a broken `ps`
// doesn't spam logs, while still surfacing that account-switch tracking stopped.
let lastErrorLogMs = Number.NEGATIVE_INFINITY;
const ERROR_LOG_THROTTLE_MS = 60_000;

/**
 * Scan the user's running sessions and, if a fresher external cookie is found,
 * adopt it as the harvested key. Returns true when the harvested value actually
 * changed, so the caller can invalidate the usage cache.
 *
 * Throttled (skips with `false` inside the window) and de-duplicated (concurrent
 * callers share one scan). A previously-good value is never cleared just because
 * no session is live at this instant — only a genuine new find replaces it.
 * Lister and clock are injectable for tests.
 */
export async function refreshHarvestedFromSessions(
  lister?: ClaudeProcLister,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (inflight) return inflight;
  if (nowMs - lastScanMs < SCAN_THROTTLE_MS) return false;
  lastScanMs = nowMs;
  const useLister = lister ?? listerOverride ?? defaultLister;
  inflight = (async () => {
    try {
      const cookie = selectFreshestExternalCookie(await useLister());
      return cookie ? setHarvestedSessionKey(cookie) : false;
    } catch (err) {
      // `ps`/`/proc` unavailable, or an unexpected failure (e.g. `ps` output
      // exceeding maxBuffer): degrade silently to the existing resolution, but
      // surface a throttled diagnostic so a *persistent* failure — which would
      // otherwise silently pin usage to the stale fallback — is diagnosable.
      // The cookie value never appears in a `ps`/exec error message, so logging
      // the message here does not leak the credential.
      if (nowMs - lastErrorLogMs >= ERROR_LOG_THROTTLE_MS) {
        lastErrorLogMs = nowMs;
        console.warn(
          "[claude-usage] session scan failed; using fallback credential:",
          err instanceof Error ? err.message : err,
        );
      }
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Reset throttle + in-flight state. Tests only. */
export function __resetScanThrottleForTests(): void {
  lastScanMs = Number.NEGATIVE_INFINITY;
  lastErrorLogMs = Number.NEGATIVE_INFINITY;
  inflight = null;
}

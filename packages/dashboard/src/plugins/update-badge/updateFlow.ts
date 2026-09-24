/**
 * Pure helpers for the in-app update flow (ADR-101): release ordering,
 * breaking-change detection, per-status consequence copy, the phase → step
 * mapping, and the post-reload "Updated" flag. No React, no fetching — the
 * status-bar item owns the state machine; this file owns the rules.
 */

import type {
  InstallMode,
  ReleaseNote,
  UpgradePhase,
  UpgradeState,
  UpgradeStatusRecord,
} from "../../api/system";

export const TERMINAL_PHASES: ReadonlySet<UpgradePhase> = new Set([
  "done",
  "rolled_back",
  "failed",
  "up_to_date",
]);

/** Mirrors the server's IN_FLIGHT_STALE_MS: a non-terminal record older than
 *  this is a job that died without a final write, not a live run. */
export const IN_FLIGHT_STALE_MS = 15 * 60 * 1000;

export function isLiveRun(rec: UpgradeStatusRecord | null): boolean {
  if (!rec || TERMINAL_PHASES.has(rec.phase)) return false;
  const t = Date.parse(rec.updatedAt);
  return Number.isFinite(t) && Date.now() - t < IN_FLIGHT_STALE_MS;
}

/** Numeric semver-ish compare ("0.10.0" > "0.9.3"); pre-release tags sort
 *  below their release. Tolerates a leading "v". */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((p) => Number(p) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export function sortNewestFirst(releases: ReleaseNote[]): ReleaseNote[] {
  return [...releases].sort((a, b) => compareVersions(b.version, a.version));
}

/** Releases whose notes flag a breaking change (case-insensitive). */
export function breakingReleases(releases: ReleaseNote[]): ReleaseNote[] {
  return releases.filter((r) => /breaking change/i.test(r.body ?? ""));
}

export function formatReleaseDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** What restarting autonomOS right now costs an agent in `status`. */
export function consequenceFor(status: string, provider?: string): string {
  switch (status) {
    case "working":
    case "compacting":
    case "orchestrating":
      return "Turn in progress — stops mid-turn, won't resume on its own";
    case "tool_running":
      return provider === "codex"
        ? "Running a command — it is killed; the thread is kept"
        : "Running a command — the command is killed";
    case "needs_input":
      return "Its pending question is dismissed — it will need re-asking";
    default:
      return "Nothing lost";
  }
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface UpdateStep {
  id: string;
  label: string;
  detail?: string;
}

/** The step list shown while the job runs, per install mode — or the
 *  shorter Restore list for a rollback job. */
export function stepsFor(
  mode: InstallMode | "rollback",
  to: string,
  opts: { asset?: string; snapshotId?: string } = {},
): UpdateStep[] {
  const restart: UpdateStep = {
    id: "restart",
    label: "Restart autonomOS",
    detail: "Agents close now and reopen after",
  };
  const reopen: UpdateStep = { id: "reopen", label: "Reopen agents" };
  if (mode === "rollback") {
    return [
      {
        id: "swap",
        label: `Put back v${to}`,
        detail: "The previous code, and its snapshot when one pairs with it",
      },
      restart,
      reopen,
    ];
  }
  const snapshot: UpdateStep = {
    id: "snapshot",
    label: "Save snapshot",
    detail: opts.snapshotId
      ? `Agents, schedules, settings → snapshots/${opts.snapshotId}`
      : "Agents, schedules, settings",
  };
  const tail: UpdateStep[] = [
    restart,
    {
      id: "health",
      label: "Health check",
      detail: `Confirm v${to} is serving, or roll back`,
    },
    reopen,
    {
      id: "verify-agents",
      label: "Verify agents",
      detail: "Every agent that was resumable still is",
    },
  ];
  if (mode === "source") {
    return [
      snapshot,
      { id: "fetch", label: `Fetch v${to}` },
      { id: "build", label: "Build", detail: "Rebuilds from source (1–3 min)" },
      ...tail,
    ];
  }
  return [
    snapshot,
    { id: "download", label: `Download v${to}`, detail: opts.asset },
    {
      id: "verify",
      label: "Verify checksum",
      detail: "SHA256 checked against the release",
    },
    {
      id: "install",
      label: "Install",
      detail: "Previous version kept for rollback",
    },
    ...tail,
  ];
}

const PHASE_STEP: Record<UpgradePhase, string | null> = {
  launching: null, // first step, not yet started
  snapshotting: "snapshot",
  fetching: "fetch",
  downloading: "download",
  verifying: "verify",
  installing: "install",
  building: "build",
  restarting: "restart",
  health_check: "health",
  // Code is live and agents reopened; the agent check runs next (the NEW
  // daemon writes `verification` ~20s later).
  done: "verify-agents",
  rolled_back: null,
  failed: null,
  up_to_date: null,
};

/** Index of the ACTIVE step for `phase` (steps before it are done);
 *  steps.length = every step complete. `done` completes everything once the
 *  agent check has reported (or when the list has no agent-check step).
 *  Unmapped phases → 0. */
export function activeStepIndex(
  steps: UpdateStep[],
  phase: UpgradePhase | undefined,
  verified = false,
): number {
  const id = phase ? PHASE_STEP[phase] : null;
  const i = id ? steps.findIndex((s) => s.id === id) : -1;
  if (phase === "done" && (verified || i === -1)) return steps.length;
  return i === -1 ? 0 : i;
}

// ── post-reload "Updated" flag ────────────────────────────────────────────

const FLAG_KEY = "autonomos:updated";

export interface UpdatedFlag {
  /** "rollback" = the in-app Restore finished; default "upgrade". */
  kind?: "upgrade" | "rollback";
  updatedTo: string;
  interruptedNames: string[];
  /** Rollback only: whether a snapshot paired with the restored version
   *  (undefined = unknown, e.g. a restore started from another tab). */
  withSnapshot?: boolean;
  /** Rollback only: the job's own summary, used when withSnapshot is unknown. */
  message?: string;
}

export function writeUpdatedFlag(flag: UpdatedFlag): void {
  try {
    sessionStorage.setItem(FLAG_KEY, JSON.stringify(flag));
  } catch {
    // Private mode / storage disabled: the banner is a courtesy, the update
    // itself already happened.
  }
}

/** Read AND clear the flag — the banner shows once per update. */
export function takeUpdatedFlag(): UpdatedFlag | null {
  try {
    const raw = sessionStorage.getItem(FLAG_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(FLAG_KEY);
    const v = JSON.parse(raw) as Partial<UpdatedFlag>;
    if (typeof v.updatedTo !== "string") return null;
    return {
      kind: v.kind === "rollback" ? "rollback" : "upgrade",
      withSnapshot:
        typeof v.withSnapshot === "boolean" ? v.withSnapshot : undefined,
      message: typeof v.message === "string" ? v.message : undefined,
      updatedTo: v.updatedTo,
      interruptedNames: Array.isArray(v.interruptedNames)
        ? v.interruptedNames.filter((n): n is string => typeof n === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** "Sep 24, 07:12". */
export function formatSnapshotDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/** "214 KB" / "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── durable "agents need attention" warning ──────────────────────────────
//
// The sessionStorage flag above only reaches the tab that ran the update, and
// only if it is still open when verification lands (~20s after the restart).
// A reload, a second tab or a closed laptop would otherwise lose the one
// warning that offers Restore. So the server's status record is the durable
// source: while the running version came from an update whose verification
// found problems, the banner resurfaces until this browser dismisses it.

const ACK_KEY = "autonomos:update-ack";

/** The `startedAt` of the update whose problems this browser dismissed. */
export function readUpdateAck(): string | null {
  try {
    return localStorage.getItem(ACK_KEY);
  } catch {
    return null;
  }
}

export function writeUpdateAck(startedAt: string): void {
  try {
    localStorage.setItem(ACK_KEY, startedAt);
  } catch {
    // Storage disabled: the warning simply comes back on the next load.
  }
}

/** A banner flag for an update with unacknowledged verification problems. */
export function resurfacedFlag(
  state: Pick<UpgradeState, "current" | "status">,
  ackedStartedAt: string | null,
): UpdatedFlag | null {
  const r = state.status;
  if (!r || r.kind === "rollback" || r.phase !== "done") return null;
  // Only while that update is what's running — after a Restore or a newer
  // update the problems no longer describe this install.
  if (r.to !== state.current) return null;
  if (!r.verification || r.verification.problems.length === 0) return null;
  if (ackedStartedAt === r.startedAt) return null;
  return { kind: "upgrade", updatedTo: r.to, interruptedNames: [] };
}

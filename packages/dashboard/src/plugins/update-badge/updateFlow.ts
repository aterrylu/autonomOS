/**
 * Pure helpers for the in-app update flow (ADR-105): release ordering,
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

/** Mirror the server's isUpgradeInFlight bounds: a non-terminal record older
 *  than this is a job that died without a final write, not a live run — and
 *  one still at "launching" after LAUNCH_STALE_MS never started at all. */
export const IN_FLIGHT_STALE_MS = 15 * 60 * 1000;
export const LAUNCH_STALE_MS = 2 * 60 * 1000;

export function isLiveRun(rec: UpgradeStatusRecord | null): boolean {
  if (!rec || TERMINAL_PHASES.has(rec.phase)) return false;
  const age = Date.now() - Date.parse(rec.updatedAt);
  if (!Number.isFinite(age)) return false;
  return (
    age < (rec.phase === "launching" ? LAUNCH_STALE_MS : IN_FLIGHT_STALE_MS)
  );
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
export function consequenceFor(status: string, _provider?: string): string {
  switch (status) {
    case "working":
    case "compacting":
    case "orchestrating":
      return "Its current task stops. Prompt it to continue.";
    case "tool_running":
      return "Its running command stops. Prompt it to continue.";
    case "needs_input":
      return "Its question to you is cleared. Tell it how to go on afterwards.";
    default:
      return "Restarts and picks up where it left off.";
  }
}

/** The text for an agent whose first task hasn't started yet. */
export const FIRST_TASK_CONSEQUENCE =
  "Its first prompt is lost. Send it again afterwards.";

/** "1 agent" / "3 agents". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What a snapshot holds — one wording everywhere (mirrors the server's
 *  SNAPSHOT_ENTRIES: agents, schedules, templates, env presets, settings). */
export const SNAPSHOT_CONTENTS =
  "Agents, schedules, templates, presets and settings";

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
  opts: {
    asset?: string;
    snapshotId?: string;
    /** "Wait for idle" run: the job re-checks the fleet before the swap. */
    waitIdle?: boolean;
    /** The job's latest word while waiting ("Waiting for api to finish"). */
    waitingMessage?: string;
  } = {},
): UpdateStep[] {
  const restart: UpdateStep = {
    id: "restart",
    label: "Restart autonomOS",
    detail: "Agents close for a few seconds",
  };
  const reopen: UpdateStep = {
    id: "reopen",
    label: "Reopen agents",
    detail: "Each reopens its own conversation",
  };
  if (mode === "rollback") {
    return [
      {
        id: "swap",
        label: `Restore v${to}`,
        detail: "Plus the snapshot from before the update, if there is one",
      },
      restart,
      reopen,
    ];
  }
  const snapshot: UpdateStep = {
    id: "snapshot",
    label: "Save a snapshot",
    detail: opts.snapshotId
      ? `${SNAPSHOT_CONTENTS} → snapshots/${opts.snapshotId}`
      : SNAPSHOT_CONTENTS,
  };
  const tail: UpdateStep[] = [
    restart,
    {
      id: "health",
      label: `Make sure v${to} started`,
      detail: "If it didn't, autonomOS restores the previous version",
    },
    reopen,
    {
      id: "verify-agents",
      label: "Check agents reopened",
      detail: "Each one reopened its own conversation",
    },
  ];
  // The job re-checks idle and THEN snapshots, right before the change: the
  // snapshot must hold the state actually left, not the state at launch.
  const wait: UpdateStep[] = opts.waitIdle
    ? [
        {
          id: "wait",
          label: "Wait for agents to finish",
          detail:
            opts.waitingMessage ??
            "Starts after every agent has been idle for 30 seconds",
        },
      ]
    : [];
  if (mode === "source") {
    return [
      { id: "fetch", label: `Fetch v${to}` },
      ...wait,
      snapshot,
      {
        id: "build",
        label: `Build v${to}`,
        detail: "From source, 1–3 minutes",
      },
      ...tail,
    ];
  }
  return [
    { id: "download", label: `Download v${to}`, detail: opts.asset },
    {
      id: "verify",
      label: "Check the download",
      detail: "SHA-256 matched against the release",
    },
    ...wait,
    snapshot,
    {
      id: "install",
      label: `Install v${to}`,
      detail: "The previous version is kept so you can restore it",
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
  waiting_idle: "wait",
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

// ── release notes as shown IN the dialog ─────────────────────────────────

/** Release bodies end with a how-to-install footer written for GitHub
 *  ("Install / upgrade: curl … | sh", "grab … from the assets below"). Inside
 *  the update dialog that tells you to update some other way and points at
 *  assets that aren't there, so it's cut: from the last horizontal rule when
 *  what follows is install instructions, plus any stray install line. */
const INSTALL_LINE =
  /install\.sh|install \/ upgrade|manual download|assets below|SHA256SUMS/i;

export function inAppNotes(body: string): string {
  const lines = body.split(/\r?\n/);
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      if (lines.slice(i + 1).some((l) => INSTALL_LINE.test(l))) end = i;
      break;
    }
  }
  return lines
    .slice(0, end)
    .filter((l) => !INSTALL_LINE.test(l))
    .join("\n")
    .trimEnd();
}

// ── the three honest stages (what the dialog shows) ──────────────────────

/** 0 Preparing · 1 Restarting · 2 Reopening agents. Everything the job does
 *  before the swap is one stage: its sub-steps fly by too fast to follow
 *  (the fine-grained list lives behind "Show details"). */
export type Stage = 0 | 1 | 2;

export function stageFor(phase: UpgradePhase | undefined): Stage {
  switch (phase) {
    case "restarting":
    case "health_check":
      return 1;
    case "done":
      return 2;
    default:
      return 0;
  }
}

/** One line for what the job is doing right now, inside its stage. */
export function stageDetail(
  phase: UpgradePhase | undefined,
  to: string,
  opts: { rollback?: boolean; message?: string } = {},
): string {
  switch (phase) {
    case "fetching":
      return `Fetching v${to}`;
    case "downloading":
      return `Downloading v${to}`;
    case "verifying":
      return "Checking the download";
    case "waiting_idle":
      return opts.message ?? "Waiting for agents to finish";
    case "snapshotting":
      return "Saving a snapshot";
    case "installing":
      return opts.rollback
        ? `Putting v${to} back in place`
        : `Installing v${to}`;
    case "building":
      return "Building from source (1–3 minutes)";
    case "restarting":
      return "Agents close for a few seconds";
    case "health_check":
      return `Making sure v${to} started`;
    case "done":
      return "Each agent reopens its own conversation";
    default:
      return "Starting…";
  }
}

// ── the breaking-change sentence, quoted instead of pointed at ───────────

const EMOJI = /\p{Extended_Pictographic}\uFE0F?/gu;

/** Markdown line → plain text: links keep their text, markers go. */
function plainText(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.|>)\s+/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(EMOJI, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text: string): string {
  const t = text.replace(/\s*\([^)]*\)/g, "").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const out = (m ? m[1] : t).trim();
  return out.length > 220 ? `${out.slice(0, 217).trimEnd()}…` : out;
}

const endWithPeriod = (t: string) => (/[.!?…]$/.test(t) ? t : `${t}.`);
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The breaking change itself, as one or two plain sentences — so the
 *  callout can say WHAT changed instead of "look for it below". Handles a
 *  `## Breaking change` heading (the bullets under it) and an inline
 *  "… Breaking change, <context>: <what> …" bullet. Null when none. */
export function breakingSummary(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/breaking change/i.test(line)) continue;
    if (/^\s*#{1,6}\s/.test(line)) {
      const items: string[] = [];
      for (let j = i + 1; j < lines.length && items.length < 2; j++) {
        if (/^\s*#{1,6}\s/.test(lines[j])) break;
        const t = plainText(lines[j]);
        if (t) items.push(endWithPeriod(cap(firstSentence(t))));
      }
      if (items.length) return items.join(" ");
      continue;
    }
    // A bold lead-in names the change ("**#360 — Old API routes removed.**").
    const bold = /\*\*(.+?)\*\*/.exec(line)?.[1];
    const title = bold
      ? plainText(bold)
          .replace(/^#?\d+\s*[—–-]\s*/, "")
          .replace(/[.:]$/, "")
      : null;
    const flat = plainText(line);
    const after = /breaking change[^:]*:\s*(.+)/i.exec(flat)?.[1];
    const what = after
      ? cap(firstSentence(after))
      : firstSentence(flat.replace(/^.*?breaking change[.:,]?\s*/i, "")) ||
        null;
    if (title && what && !/breaking change/i.test(title))
      return `${title}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
    if (what) return cap(what);
  }
  return null;
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

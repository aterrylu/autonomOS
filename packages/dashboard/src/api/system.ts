/**
 * /api/system/* — version, release notes, and the in-app update (ADR-105).
 *
 * Types are declared here rather than in @autonomos/core: they are the
 * server route's wire contract (routes/system.ts), consumed only by the
 * update-badge plugin. Every field is read defensively by the caller — an
 * older server may omit the additive ones.
 */

import { request } from "./core";

export type InstallMode = "bundle" | "source" | null;

export interface SystemVersion {
  version: string;
  platform?: string;
  arch?: string;
  latest?: string | null;
  updateAvailable?: boolean;
  checkedAt?: string | null;
  releaseUrl?: string | null;
  installMode?: InstallMode;
}

export interface ReleaseNote {
  version: string;
  name: string;
  /** GitHub release markdown — UNTRUSTED. Render with releaseMarkdown only. */
  body: string;
  url: string | null;
  publishedAt: string | null;
  /** Set from a structured marker in the body (never prose-sniffed): this
   *  release changes the on-disk agent format, so going back needs the
   *  pre-update snapshot. */
  storageFormatChange?: boolean;
}

export interface SystemReleases {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  /** null = notes unavailable (fetch failed / rate-limited). */
  releases: ReleaseNote[] | null;
}

export type UpgradePhase =
  | "launching"
  | "snapshotting"
  | "fetching"
  | "downloading"
  | "verifying"
  | "waiting_idle"
  | "installing"
  | "building"
  | "restarting"
  | "health_check"
  | "done"
  | "rolled_back"
  | "failed"
  | "up_to_date";

export interface UpgradeVerification {
  checkedAt: string;
  /** Agents from the snapshot baseline that were checked. */
  checked: number;
  problems: { id: string; name: string; issue: string }[];
}

export interface UpgradeStatusRecord {
  phase: UpgradePhase;
  from: string;
  /** Target version (the version being RESTORED for kind "rollback"). */
  to: string | null;
  message?: string;
  startedAt: string;
  updatedAt: string;
  /** Absent on records written before ADR-105's amendment = "upgrade". */
  kind?: "upgrade" | "rollback";
  /** The pre-upgrade state snapshot this run took. */
  snapshotId?: string;
  /** Written by the NEW daemon once its agents have resumed after "done". */
  verification?: UpgradeVerification;
  /** Launched by "wait for idle": re-checks the fleet before the swap. */
  waitIdle?: boolean;
}

export interface BusyAgent {
  id: string;
  name: string;
  status: string;
  /** "first_task": just spawned; its first task hasn't started yet. */
  reason?: "first_task";
}

/** An agent's background shell work an update restart would stop. */
export interface BackgroundWork {
  id: string;
  name: string;
  processes: { pid: number; command: string }[];
}

export interface UpgradeState {
  current: string;
  supervised: boolean;
  installMode: InstallMode;
  status: UpgradeStatusRecord | null;
  armed: { target: string; armedAt: string; idleSince: string | null } | null;
  idleWindowMs: number;
  busy: BusyAgent[];
  /** Warn-only: never part of "busy". Absent from older servers. */
  background?: BackgroundWork[];
  /** Judged on the server's clock (a skewed browser clock can't). */
  inFlight?: boolean;
}

export type StartUpgradeResult =
  | { ok: true; armed: NonNullable<UpgradeState["armed"]> }
  | { ok: true; launched: true };

export interface SnapshotInfo {
  id: string;
  fromVersion: string;
  toVersion: string | null;
  createdAt: string;
  entries: string[];
  bytes: number;
  agentCount: number;
}

export interface SystemSnapshots {
  /** Newest first. */
  snapshots: SnapshotInfo[];
  /** What Restore would put back; null = nothing to restore. */
  rollback: { version: string; snapshotId: string | null } | null;
}

type Opts = { signal?: AbortSignal };

export const systemApi = {
  /** Always `fresh`: the restart-gap poll must put a REAL request on the wire
   *  each tick, and a timed-out probe's abort must kill its socket. */
  version: (opts: Opts = {}) =>
    request<SystemVersion>("/api/system/version", { ...opts, fresh: true }),
  releases: (opts: Opts = {}) =>
    request<SystemReleases>("/api/system/releases", opts),
  upgradeState: (opts: Opts = {}) =>
    request<UpgradeState>("/api/system/upgrade", { ...opts, fresh: true }),
  /** Run the release check now (Settings → Updates → Check now). */
  checkUpdates: () =>
    request<{
      current: string;
      latest: string | null;
      updateAvailable: boolean;
      checkedAt: string | null;
    }>("/api/system/check-updates", { method: "POST", body: {} }),
  /** `expectedVersion`: the version whose notes the dialog showed — the
   *  server refuses (VERSION_CHANGED) if `latest` moved since. */
  startUpgrade: (when: "idle" | "now", expectedVersion?: string) =>
    request<StartUpgradeResult>("/api/system/upgrade", {
      method: "POST",
      body: { when, ...(expectedVersion && { expectedVersion }) },
    }),
  snapshots: (opts: Opts = {}) =>
    request<SystemSnapshots>("/api/system/snapshots", { ...opts, fresh: true }),
  startRollback: () =>
    request<{
      ok: true;
      launched: true;
      target: { version: string; snapshotId: string | null };
    }>("/api/system/rollback", { method: "POST", body: {} }),
  cancelUpgrade: () =>
    request<{ ok: true }>("/api/system/upgrade", { method: "DELETE" }),
};

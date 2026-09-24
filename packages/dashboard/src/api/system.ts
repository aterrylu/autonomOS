/**
 * /api/system/* — version, release notes, and the in-app update (ADR-101).
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
  /** Absent on records written before ADR-101's amendment = "upgrade". */
  kind?: "upgrade" | "rollback";
  /** The pre-upgrade state snapshot this run took. */
  snapshotId?: string;
  /** Written by the NEW daemon ~20s after "done". */
  verification?: UpgradeVerification;
}

export interface BusyAgent {
  id: string;
  name: string;
  status: string;
}

export interface UpgradeState {
  current: string;
  supervised: boolean;
  installMode: InstallMode;
  status: UpgradeStatusRecord | null;
  armed: { target: string; armedAt: string; idleSince: string | null } | null;
  idleWindowMs: number;
  busy: BusyAgent[];
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
  startUpgrade: (when: "idle" | "now") =>
    request<StartUpgradeResult>("/api/system/upgrade", {
      method: "POST",
      body: { when },
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

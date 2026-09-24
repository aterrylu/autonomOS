// Pre-upgrade state snapshots (ADR-101 amendment, Terry's picks).
//
// The health gate + auto-rollback protect the DAEMON. They do not protect
// agent STATE: a rollback restores code, not the records a newer version may
// have rewritten. So every `autonomos upgrade` — dashboard or shell — first
// copies the small, local state an update could break into
// $configDir/snapshots/<from-version>-<stamp>/, and every rollback restores
// code AND that snapshot as one pair, so old code never runs on newer records.
//
// What is (and is not) in a snapshot:
//   IN:  agents/ (the agent → provider session/thread MAPPING — what the Codex
//        incident lost), agent-tokens/, schedules/, templates/, env-presets/
//        (secrets — modes preserved, 0600 stays 0600), handoff-queues/,
//        settings.json, token, pinned-sessions.json, gemini-settings.json,
//        sessions.json (pre-migration legacy).
//   OUT: logs/, schedule-runs/ (append-only history), control.sock, pid files,
//        upgrade-status.json, snapshots/ itself. Conversations are never
//        here at all — Claude Code, Codex and Gemini keep their own history
//        outside $configDir, and an update never touches it.
// Measured on a real install: < 200 KB.

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./configDir.js";

export const SNAPSHOT_ENTRIES = [
  "agents",
  "agent-tokens",
  "schedules",
  "templates",
  "env-presets",
  "handoff-queues",
  "settings.json",
  "token",
  "pinned-sessions.json",
  "gemini-settings.json",
  "sessions.json",
] as const;

export const SNAPSHOT_RETENTION = 5;

export type SnapshotAgent = {
  id: string;
  name: string;
  provider: string;
  status: string;
  providerSessionId?: string;
  providerThreadId?: string;
};

export type SnapshotManifest = {
  id: string;
  fromVersion: string;
  toVersion: string | null;
  createdAt: string;
  entries: string[];
  bytes: number;
  /** Agent mapping at snapshot time — the baseline post-upgrade verification compares against. */
  agents: SnapshotAgent[];
};

export function snapshotsDir(configDir = getConfigDir()): string {
  return join(configDir, "snapshots");
}

function dirBytes(p: string): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += dirBytes(join(p, e));
  return n;
}

function readAgentsForManifest(agentsDir: string): SnapshotAgent[] {
  if (!existsSync(agentsDir)) return [];
  const out: SnapshotAgent[] = [];
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith(".json") || f.endsWith(".tmp.json")) continue;
    try {
      const a = JSON.parse(readFileSync(join(agentsDir, f), "utf-8"));
      if (typeof a?.id !== "string") continue;
      out.push({
        id: a.id,
        name: String(a.name ?? a.id),
        provider: String(a.provider ?? "claude-code"),
        status: String(a.status ?? "unknown"),
        providerSessionId:
          typeof a.providerSessionId === "string"
            ? a.providerSessionId
            : undefined,
        providerThreadId:
          typeof a.providerThreadId === "string"
            ? a.providerThreadId
            : undefined,
      });
    } catch {
      // unreadable record: still copied verbatim, just not in the baseline
    }
  }
  return out;
}

/**
 * Copy the state entries into a new snapshot. Staged under a dot-name and
 * renamed into place, so a crash mid-copy never leaves a half snapshot that
 * a later restore would trust. Prunes to SNAPSHOT_RETENTION afterwards.
 */
export function createSnapshot(
  fromVersion: string,
  toVersion: string | null,
  configDir = getConfigDir(),
  now = new Date(),
): SnapshotManifest {
  const root = snapshotsDir(configDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const id = `${fromVersion}-${stamp}`;
  const staging = join(root, `.staging-${id}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { mode: 0o700 });

  const entries: string[] = [];
  for (const e of SNAPSHOT_ENTRIES) {
    const src = join(configDir, e);
    if (!existsSync(src)) continue;
    // cpSync preserves file modes — the 0600 on env-presets / token / agent
    // tokens carries over (pinned by a test).
    cpSync(src, join(staging, e), {
      recursive: true,
      preserveTimestamps: true,
    });
    entries.push(e);
  }
  const manifest: SnapshotManifest = {
    id,
    fromVersion,
    toVersion,
    createdAt: now.toISOString(),
    entries,
    bytes: dirBytes(staging),
    agents: readAgentsForManifest(join(staging, "agents")),
  };
  writeFileSync(
    join(staging, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  renameSync(staging, join(root, id));
  pruneSnapshots(configDir);
  return manifest;
}

export function listSnapshots(configDir = getConfigDir()): SnapshotManifest[] {
  const root = snapshotsDir(configDir);
  if (!existsSync(root)) return [];
  const out: SnapshotManifest[] = [];
  for (const d of readdirSync(root)) {
    if (d.startsWith(".")) continue;
    try {
      out.push(
        JSON.parse(readFileSync(join(root, d, "manifest.json"), "utf-8")),
      );
    } catch {
      // not a complete snapshot — never offered for restore
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pruneSnapshots(
  configDir = getConfigDir(),
  keep = SNAPSHOT_RETENTION,
): void {
  for (const s of listSnapshots(configDir).slice(keep)) {
    rmSync(join(snapshotsDir(configDir), s.id), {
      recursive: true,
      force: true,
    });
  }
}

/** The newest snapshot taken FROM `version` — the state that pairs with that version's code. */
export function snapshotForVersion(
  version: string,
  configDir = getConfigDir(),
): SnapshotManifest | null {
  return (
    listSnapshots(configDir).find((s) => s.fromVersion === version) ?? null
  );
}

/**
 * Restore a snapshot's entries over the live state. The CALLER must have
 * stopped the daemon first — a running daemon would keep writing the records
 * being replaced. Displaced live entries are moved aside (not deleted) until
 * the swap completes, then removed; entries absent from the snapshot are left
 * alone (they didn't exist at snapshot time and nothing reads them on old
 * code, e.g. a directory a newer version introduced).
 */
export function restoreSnapshot(
  id: string,
  configDir = getConfigDir(),
): SnapshotManifest {
  const src = join(snapshotsDir(configDir), id);
  const manifest = JSON.parse(
    readFileSync(join(src, "manifest.json"), "utf-8"),
  ) as SnapshotManifest;
  const trash = join(configDir, `.restore-displaced-${Date.now()}`);
  mkdirSync(trash, { mode: 0o700 });
  for (const e of manifest.entries) {
    const live = join(configDir, e);
    if (existsSync(live)) renameSync(live, join(trash, e));
    cpSync(join(src, e), live, { recursive: true, preserveTimestamps: true });
  }
  rmSync(trash, { recursive: true, force: true });
  return manifest;
}

/** Remove one snapshot (used when an upgrade turns out to be a no-op). */
export function deleteSnapshot(id: string, configDir = getConfigDir()): void {
  if (!id || id.includes("/") || id.startsWith(".")) return;
  rmSync(join(snapshotsDir(configDir), id), { recursive: true, force: true });
}

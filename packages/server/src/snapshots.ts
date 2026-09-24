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
  // No pruning here: a snapshot is taken before anyone knows whether the run
  // will change anything, and pruning now would evict a real snapshot for
  // every no-op or failed attempt. Callers prune once something changed.
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
  /** Ids never removed by this prune (e.g. the snapshot a Restore just used). */
  protect: readonly string[] = [],
): void {
  const all = listSnapshots(configDir);
  const kept = new Set(all.slice(0, keep).map((s) => s.id));
  for (const s of all) {
    if (kept.has(s.id) || protect.includes(s.id)) continue;
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
 * being replaced.
 *
 * Nothing is destroyed and nothing is left half-done:
 *   1. The live state is first saved as its OWN snapshot (from `liveVersion`),
 *      so what the newer version wrote — agents created since, schedules,
 *      env-preset keys — stays recoverable, and swapping forward again pairs
 *      with it. If that save fails, nothing is restored.
 *   2. Every entry is copied into a staging dir. A copy failure here leaves
 *      the live state untouched.
 *   3. Entries are swapped in by rename (same filesystem). If a rename fails,
 *      the swaps already made are undone; the error names anything that could
 *      not be put back and where its original is.
 * Entries absent from the snapshot are left alone (they didn't exist at
 * snapshot time and nothing reads them on old code).
 */
export function restoreSnapshot(
  id: string,
  liveVersion: string,
  configDir = getConfigDir(),
): { restored: SnapshotManifest; saved: SnapshotManifest } {
  const src = join(snapshotsDir(configDir), id);
  const manifest = JSON.parse(
    readFileSync(join(src, "manifest.json"), "utf-8"),
  ) as SnapshotManifest;

  const saved = createSnapshot(liveVersion, manifest.fromVersion, configDir);

  const tag = Date.now();
  const stage = join(configDir, `.restore-staging-${tag}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const e of manifest.entries) {
      cpSync(join(src, e), join(stage, e), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error(
      `couldn't read snapshot ${id} (${err instanceof Error ? err.message : err}) — live state was left as it was`,
    );
  }

  const displaced = join(configDir, `.restore-displaced-${tag}`);
  mkdirSync(displaced, { mode: 0o700 });
  const swapped: { entry: string; hadLive: boolean }[] = [];
  try {
    for (const e of manifest.entries) {
      const live = join(configDir, e);
      const hadLive = existsSync(live);
      if (hadLive) renameSync(live, join(displaced, e));
      swapped.push({ entry: e, hadLive });
      renameSync(join(stage, e), live);
    }
  } catch (err) {
    const stuck: string[] = [];
    for (const { entry, hadLive } of swapped.reverse()) {
      const live = join(configDir, entry);
      try {
        // Staged copy already went live → take it out again.
        if (!existsSync(join(stage, entry))) {
          rmSync(live, { recursive: true, force: true });
        }
        if (hadLive) renameSync(join(displaced, entry), live);
      } catch {
        stuck.push(entry);
      }
    }
    rmSync(stage, { recursive: true, force: true });
    const why = err instanceof Error ? err.message : String(err);
    if (stuck.length === 0) {
      rmSync(displaced, { recursive: true, force: true });
      throw new Error(
        `restoring snapshot ${id} failed (${why}) — live state was put back as it was`,
      );
    }
    throw new Error(
      `restoring snapshot ${id} failed (${why}) and ${stuck.join(", ")} could not be put back — the originals are in ${displaced}, and a full copy is in snapshots/${saved.id}/`,
    );
  }
  rmSync(stage, { recursive: true, force: true });
  // The displaced copies are redundant with `saved`.
  rmSync(displaced, { recursive: true, force: true });
  pruneSnapshots(configDir, SNAPSHOT_RETENTION, [id, saved.id]);
  return { restored: manifest, saved };
}

/** Remove one snapshot (used when an upgrade turns out to be a no-op). */
export function deleteSnapshot(id: string, configDir = getConfigDir()): void {
  if (!id || id.includes("/") || id.startsWith(".")) return;
  rmSync(join(snapshotsDir(configDir), id), { recursive: true, force: true });
}

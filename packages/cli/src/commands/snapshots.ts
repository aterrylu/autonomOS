// `autonomos snapshots list` — the pre-update state snapshots (ADR-103).
//
// Findable later, not just in the moment: every `autonomos upgrade` saves a
// snapshot of agent state first; `autonomos rollback` restores the one that
// pairs with the version it returns to. This lists them with their paths so
// a human (or a recovery by hand) can see exactly what exists.

import { join } from "node:path";
import {
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  SNAPSHOT_RETENTION,
  snapshotsDir,
} from "@autonomos/server/snapshots.js";
import { getServerVersion } from "@autonomos/server/version.js";

export async function runSnapshotsCommand(
  argv: readonly string[],
): Promise<number> {
  const sub = argv[0] ?? "list";
  if (sub === "create") {
    // Used by install.sh before it swaps a new bundle in (ADR-103): the
    // running version's state, taken by the running version's own code.
    try {
      const m = createSnapshot(getServerVersion(), null);
      // install.sh swaps a bundle in right after this, so it counts.
      pruneSnapshots(undefined, SNAPSHOT_RETENTION, [m.id]);
      console.log(join(snapshotsDir(), m.id));
      return 0;
    } catch (err) {
      console.error(
        `✗ Snapshot failed: ${err instanceof Error ? err.message : err}`,
      );
      return 1;
    }
  }
  if (sub !== "list") {
    console.error("Usage: autonomos snapshots list | create");
    return 64;
  }
  const snaps = listSnapshots();
  if (snaps.length === 0) {
    console.log(
      "No snapshots yet — one is saved automatically before every update.",
    );
    return 0;
  }
  console.log(`Snapshots in ${snapshotsDir()} (newest first):\n`);
  for (const s of snaps) {
    const to = s.toVersion ? ` → v${s.toVersion}` : "";
    console.log(
      `  before update from v${s.fromVersion}${to}  ·  ${s.createdAt}  ·  ${Math.round(s.bytes / 1024)} KB  ·  ${s.agents.length} agents`,
    );
    console.log(`    ${join(snapshotsDir(), s.id)}`);
  }
  console.log(
    "\n`autonomos rollback` restores the previous version together with the snapshot that pairs with it.",
  );
  return 0;
}

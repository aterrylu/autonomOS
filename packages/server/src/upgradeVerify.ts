// Post-upgrade agent verification (ADR-101 amendment).
//
// The health gate proves the DAEMON came up; it says nothing about agents.
// After an update the new daemon compares the live agents against the
// baseline in the pre-upgrade snapshot's manifest and records the verdict in
// the status file — the dashboard's success banner reads it and either says
// "all N agents verified" or names the agent that needs attention next to a
// Restore action. It WARNS; it never restores on its own (Terry: never
// auto-restore behind the operator's back).
//
// What "verified" means, precisely (no claim beyond what is checked):
//   - the agent's record is present and loaded (a newer-schema or corrupt
//     record would be skipped by the loader and show up as missing here),
//   - its provider session id — and Codex thread id, when it had one — is
//     byte-identical to the snapshot's (the mapping the Codex incident lost),
//   - an agent that was running before is running again (agents resume at
//     boot; one that failed to resume is exited, with its reason).
// It is NOT an end-to-end "send a turn and get a reply" probe.
//
// Ordering: the upgrade JOB writes the final "done" after its health gate;
// this runs in the NEW daemon and waits for that "done" before writing, so
// the two writers never race on the file (read-merge-write, atomic).

import { listAgents } from "./agents/store.js";
import { listSnapshots } from "./snapshots.js";
import {
  advanceUpgradeStatus,
  readUpgradeStatus,
  type UpgradeVerification,
  upgradeStatusPath,
} from "./upgradeStatus.js";
import { getServerVersion } from "./version.js";

/** Pure comparison — exported for tests. */
export function verifyAgainstBaseline(
  baseline: ReturnType<typeof listSnapshots>[number]["agents"],
  live: ReturnType<typeof listAgents>,
): UpgradeVerification["problems"] {
  const byId = new Map(live.map((a) => [a.id, a]));
  const problems: UpgradeVerification["problems"] = [];
  for (const b of baseline) {
    const a = byId.get(b.id);
    if (!a) {
      problems.push({
        id: b.id,
        name: b.name,
        issue: "Its record is missing or couldn't be read",
      });
      continue;
    }
    if (b.providerSessionId && a.providerSessionId !== b.providerSessionId) {
      problems.push({
        id: b.id,
        name: b.name,
        issue: "Its conversation id changed during the update",
      });
      continue;
    }
    if (b.providerThreadId && a.providerThreadId !== b.providerThreadId) {
      problems.push({
        id: b.id,
        name: b.name,
        issue: a.providerThreadId
          ? "Its Codex thread id changed during the update"
          : "Its Codex thread id is missing from its record",
      });
      continue;
    }
    if (b.status === "running" && a.status !== "running") {
      const why = (a as { exitReason?: string }).exitReason;
      problems.push({
        id: b.id,
        name: b.name,
        issue: `It didn't come back after the restart${why ? ` (${why})` : ""}`,
      });
    }
  }
  return problems;
}

const POLL_MS = 3_000;
const WAIT_FOR_DONE_MS = 3 * 60_000;
// Agents resume at boot; a failed resume exits within seconds. Give that
// time to surface before judging "running again".
const SETTLE_MS = 20_000;

export function startPostUpgradeVerification(): void {
  const path = upgradeStatusPath();
  const initial = readUpgradeStatus(path);
  if (
    !initial ||
    initial.verification ||
    !initial.snapshotId ||
    initial.to !== getServerVersion()
  ) {
    return; // not a freshly-updated boot
  }
  const deadline = Date.now() + WAIT_FOR_DONE_MS;
  const poll = setInterval(() => {
    const rec = readUpgradeStatus(path);
    if (!rec || rec.verification) return void clearInterval(poll);
    if (rec.phase !== "done") {
      if (Date.now() > deadline) clearInterval(poll);
      return;
    }
    clearInterval(poll);
    const t = setTimeout(() => {
      try {
        const snap = listSnapshots().find((s) => s.id === rec.snapshotId);
        const baseline = snap?.agents ?? [];
        const problems = snap
          ? verifyAgainstBaseline(baseline, listAgents())
          : [
              {
                id: "-",
                name: "snapshot",
                issue: "The pre-update snapshot could not be read",
              },
            ];
        advanceUpgradeStatus(path, {
          phase: "done",
          verification: {
            checkedAt: new Date().toISOString(),
            checked: baseline.length,
            problems,
          },
        });
        if (problems.length) {
          console.warn(
            `[upgrade] post-update verification: ${problems.length} agent(s) need attention — ${problems.map((p) => `${p.name}: ${p.issue}`).join("; ")}`,
          );
        }
      } catch (err) {
        console.warn(
          `[upgrade] post-update verification failed to run: ${err instanceof Error ? err.message : err}`,
        );
      }
    }, SETTLE_MS);
    t.unref();
  }, POLL_MS);
  poll.unref();
}

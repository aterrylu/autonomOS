// Post-upgrade agent verification (ADR-105 amendment).
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

import { wasFreshStart } from "./agents/freshStarts.js";
import { listAgents } from "./agents/store.js";
import { listSnapshots, type SnapshotAgent } from "./snapshots.js";
import {
  advanceUpgradeStatus,
  readUpgradeStatus,
  type UpgradeStatusRecord,
  type UpgradeVerification,
  upgradeStatusPath,
} from "./upgradeStatus.js";
import { getServerVersion } from "./version.js";

/** Pure comparison — exported for tests. */
export function verifyAgainstBaseline(
  baseline: SnapshotAgent[],
  live: ReturnType<typeof listAgents>,
  isFreshStart: typeof wasFreshStart = wasFreshStart,
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
    // An agent that never conversed had nothing saved, so its resume started
    // fresh under a new id — nothing was lost (agents/freshStarts.ts).
    if (
      b.providerSessionId &&
      a.providerSessionId !== b.providerSessionId &&
      !isFreshStart(b.id, "session", b.providerSessionId)
    ) {
      problems.push({
        id: b.id,
        name: b.name,
        issue: "It reopened on a different conversation",
      });
      continue;
    }
    if (
      b.providerThreadId &&
      a.providerThreadId !== b.providerThreadId &&
      !isFreshStart(b.id, "thread", b.providerThreadId)
    ) {
      problems.push({
        id: b.id,
        name: b.name,
        issue: a.providerThreadId
          ? "It reopened on a different Codex conversation"
          : "Its Codex conversation is missing from its record",
      });
      continue;
    }
    if (b.status === "running" && a.status !== "running") {
      const why = (a as { exitReason?: string }).exitReason;
      problems.push({
        id: b.id,
        name: b.name,
        issue: `It didn't reopen after the restart${why ? ` (${why})` : ""}`,
      });
    }
  }
  return problems;
}

const POLL_MS = 3_000;
const WAIT_FOR_DONE_MS = 3 * 60_000;
/** Mutable so tests can shrink the waits. */
export const verifyTiming = {
  /** Resume is sequential per agent (sidecars first); bounded so a hung
   *  resume still gets a verdict. */
  resumeWaitMs: 3 * 60_000,
  /** After resume returns, a failed resume still needs a moment to exit and
   *  be marked (Codex "died immediately" lands within ~1s; give it room). */
  settleMs: 10_000,
};

let markResumed: () => void = () => {};
let resumed: Promise<void> = new Promise((r) => {
  markResumed = r;
});
/** Called once boot's resumeActiveAgents() has settled (run.ts). */
export function noteAgentsResumed(): void {
  markResumed();
}
/** Test seam: a fresh, unresolved resume signal. */
export function _resetResumeSignalForTesting(): void {
  resumed = new Promise((r) => {
    markResumed = r;
  });
}

/** unref'd: a pending verdict must never keep the daemon alive. A zero wait
 *  resolves without a timer — an unref'd timer as the ONLY pending work
 *  lets the event loop drain before it fires (seen in CI's test runner). */
function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms).unref());
}

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
      if (Date.now() > deadline) {
        clearInterval(poll);
        console.warn(
          `[upgrade] post-update verification skipped: the update job never reported done (last phase: ${rec.phase})`,
        );
      }
      return;
    }
    clearInterval(poll);
    void verifyRun(path, rec);
  }, POLL_MS);
  poll.unref();
}

/** Judge one finished run once its agents have actually been resumed. */
export async function verifyRun(
  path: string,
  rec: UpgradeStatusRecord,
): Promise<void> {
  const timedOut = await Promise.race([
    resumed.then(() => false),
    sleep(verifyTiming.resumeWaitMs).then(() => true),
  ]);
  if (timedOut) {
    console.warn(
      "[upgrade] agents were still resuming after 3 minutes; verifying anyway",
    );
  }
  await sleep(verifyTiming.settleMs);
  try {
    // Only annotate THE SAME finished run: in the meantime the operator may
    // have started a Restore, whose fresh record must not be merged into
    // (or marked "done" by) this verdict.
    const current = readUpgradeStatus(path);
    if (
      !current ||
      current.startedAt !== rec.startedAt ||
      current.phase !== "done" ||
      current.verification
    ) {
      return;
    }
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
}

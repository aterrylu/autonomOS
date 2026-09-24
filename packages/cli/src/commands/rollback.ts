// `autonomos rollback` — return to the version the last upgrade displaced,
// then restart (ADR-077).
//
// Bundle mode: swap the live bundle with the `.previous` directory.
// Source mode: checkout install.json's previousRef and rebuild.
// Both are one cycle deep and symmetric — rolling back twice returns to
// where you started, so this doubles as "roll forward again".
//
// Exit codes:
//   0  rolled back (verified where verifiable)
//   1  failure (nothing to roll back to, git/filesystem error)
//   2  unsupported install shape (dev checkout / unknown)

import {
  type ResolvedInstall,
  resolveInstall,
} from "@autonomos/server/installInfo.js";
import { performSourceRollback } from "@autonomos/server/sourceUpgrade.js";
import { performRollback } from "@autonomos/server/upgrade.js";
import { restartDaemonAfterSwap } from "../lib/apply-bundle.js";
import { restoreStateFor } from "../lib/state-pair.js";
import {
  makeReporter,
  type Reporter,
  statusFileArg,
  withTerminalStatus,
} from "../lib/status-report.js";

export async function runRollbackCommand(
  argv: readonly string[] = [],
): Promise<number> {
  // --status-file: the in-app Restore (ADR-101) runs this same command as an
  // out-of-band job and follows it through the status file.
  const statusFile = statusFileArg(argv);
  return withTerminalStatus(statusFile, { kind: "rollback" }, () =>
    rollbackCommand(makeReporter(statusFile, { kind: "rollback" })),
  );
}

async function rollbackCommand(report: Reporter): Promise<number> {
  let install: ResolvedInstall;
  try {
    install = resolveInstall();
  } catch (err) {
    report("failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  const result =
    install.info.mode === "source"
      ? performSourceRollback(install.bundleDir, install.info)
      : performRollback(install.bundleDir);
  if (result.status === "error") {
    report("failed", { message: result.message });
    console.error(`✗ Rollback failed: ${result.message}`);
    return 1;
  }

  console.log(`✓ Rolled back ${result.from} → ${result.to}.`);
  console.log(
    install.info.mode === "source"
      ? "  The displaced checkout is recorded in install.json (run rollback again to swap forward)."
      : `  The displaced version is now at ${install.bundleDir}.previous ` +
          "(run rollback again to swap forward).",
  );

  // Code and state move together: restore the snapshot taken when this
  // version was left (daemon stopped first), then restart onto both.
  const state = await restoreStateFor(result.to, result.from);
  console.log(
    state.restored
      ? `✓ Restored agent state from snapshots/${state.snapshot.id}. The v${result.from} state was saved as snapshots/${state.saved.id} (rolling forward again restores it).`
      : `⚠️  Agent state not restored: ${state.reason}.`,
  );
  report("restarting", { from: result.from, to: result.to });
  const outcome = await restartDaemonAfterSwap(result.to);
  const stateNote = state.restored
    ? "Your agents' setup was restored from the snapshot taken before the update."
    : `Agent state was not restored: ${state.reason}.`;
  if (outcome.kind === "restart-failed") {
    // With a state restore the daemon was STOPPED first, so a failed restart
    // leaves it down — say that, not "still on the previous version".
    const msg = state.restored
      ? "Rollback and state restore are on disk, but the service could not be restarted — autonomOS is stopped. Fix the supervisor, then run: autonomos restart"
      : "Rollback is on disk, but the supervisor restart could not be issued — the daemon is likely still on the previous version. Fix the supervisor, then run: autonomos restart";
    report("failed", { message: msg });
    console.error(`✗ ${msg}`);
    return 1;
  }
  if (outcome.kind === "not-verified") {
    report("failed", {
      message: `Restored v${result.to}, but couldn't verify it came up. ${stateNote} Check \`autonomos status\` on the host.`,
    });
    console.error(
      `⚠️  Could not verify ${result.to} came up after the restart. ` +
        "Check: autonomos status / autonomos logs",
    );
    // Deliberately no automatic counter-rollback here: the operator asked for
    // this version explicitly, and ping-ponging between two bad bundles is
    // worse than stopping with a clear message.
    return 1;
  }
  report("done", { message: `Restored v${result.to}. ${stateNote}` });
  return 0;
}

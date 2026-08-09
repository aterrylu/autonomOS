// `autonomos rollback` — swap the live bundle with `.previous` and restart
// (ADR-076).
//
// `.previous` is the version displaced by the most recent upgrade (kept for
// exactly one cycle). The swap is symmetric: rolling back twice returns to
// where you started, so this doubles as "roll forward again".
//
// Exit codes:
//   0  rolled back (verified where verifiable)
//   1  failure (no .previous, filesystem error)
//   2  unsupported install shape (source mode / dev checkout / unknown)

import {
  type ResolvedInstall,
  resolveInstall,
} from "@autonomos/server/installInfo.js";
import { performRollback } from "@autonomos/server/upgrade.js";
import { restartDaemonAfterSwap } from "../lib/apply-bundle.js";

export async function runRollbackCommand(): Promise<number> {
  let install: ResolvedInstall;
  try {
    install = resolveInstall();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  if (install.info.mode === "source") {
    console.error(
      "This is a source (git clone) install. Roll back with git instead:\n" +
        "  git checkout <previous-tag> && make prod",
    );
    return 2;
  }

  const result = performRollback(install.bundleDir);
  if (result.status === "error") {
    console.error(`✗ Rollback failed: ${result.message}`);
    return 1;
  }

  console.log(`✓ Rolled back ${result.from} → ${result.to}.`);
  console.log(
    `  The displaced version is now at ${install.bundleDir}.previous ` +
      "(run rollback again to swap forward).",
  );

  const outcome = await restartDaemonAfterSwap(result.to);
  if (outcome.kind === "restart-failed") {
    console.error(
      `✗ Rollback is on disk, but the supervisor restart could not be ` +
        `issued — the daemon is likely still on the previous version. ` +
        `Fix the supervisor, then run: autonomos restart`,
    );
    return 1;
  }
  if (outcome.kind === "not-verified") {
    console.error(
      `⚠️  Could not verify ${result.to} came up after the restart. ` +
        "Check: autonomos status / autonomos logs",
    );
    // Deliberately no automatic counter-rollback here: the operator asked for
    // this version explicitly, and ping-ponging between two bad bundles is
    // worse than stopping with a clear message.
    return 1;
  }
  return 0;
}

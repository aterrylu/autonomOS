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

export async function runRollbackCommand(): Promise<number> {
  let install: ResolvedInstall;
  try {
    install = resolveInstall();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }

  const result =
    install.info.mode === "source"
      ? performSourceRollback(install.info.prefix, install.info)
      : performRollback(install.bundleDir);
  if (result.status === "error") {
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

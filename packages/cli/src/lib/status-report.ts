// Progress reporting for the out-of-band update/restore job (ADR-105).
//
// The in-app flow runs `autonomos upgrade|rollback --status-file=…` as a job
// under the supervisor and follows it through that file — the daemon it would
// otherwise ask is the thing being restarted. For a shell run there is no
// status file and every report is a no-op.
//
// Progress phases are cosmetic: a failed write must never change the job's
// outcome. TERMINAL phases are not cosmetic — the dashboard and the new
// daemon's verification both wait for one — so those are retried and a
// failure is logged loudly. And a job that throws still ends with a terminal
// record (withTerminalStatus), or the dashboard would follow it forever.

import {
  advanceUpgradeStatus,
  readUpgradeStatus,
  TERMINAL_PHASES,
  type UpgradePhase,
  type UpgradeStatusRecord,
} from "@autonomos/server/upgradeStatus.js";

export type ReportExtra = Partial<
  Omit<UpgradeStatusRecord, "phase" | "startedAt" | "updatedAt">
>;
export type Reporter = (phase: UpgradePhase, extra?: ReportExtra) => void;

export function statusFileArg(argv: readonly string[]): string | undefined {
  return argv
    .find((a) => a.startsWith("--status-file="))
    ?.slice("--status-file=".length);
}

export function makeReporter(
  statusFile: string | undefined,
  base: ReportExtra = {},
): Reporter {
  return (phase, extra = {}) => {
    if (!statusFile) return;
    const patch = { ...base, phase, ...extra };
    const attempts = TERMINAL_PHASES.has(phase) ? 2 : 1;
    for (let i = 1; i <= attempts; i++) {
      try {
        advanceUpgradeStatus(statusFile, patch);
        return;
      } catch (err) {
        const why = err instanceof Error ? err.message : err;
        if (i < attempts) continue;
        if (TERMINAL_PHASES.has(phase)) {
          console.error(
            `[upgrade] could not record the final "${phase}" in ${statusFile}: ${why} — the dashboard can't see this outcome; check \`autonomos status\``,
          );
        } else {
          console.warn(`[upgrade] could not write status file: ${why}`);
        }
      }
    }
  };
}

/** Run a job body; if it throws before recording an outcome, record one. */
export async function withTerminalStatus(
  statusFile: string | undefined,
  base: ReportExtra,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (err) {
    if (statusFile) {
      const current = readUpgradeStatus(statusFile);
      if (!current || !TERMINAL_PHASES.has(current.phase)) {
        makeReporter(statusFile, base)("failed", {
          message: `The ${base.kind === "rollback" ? "restore" : "update"} stopped unexpectedly: ${err instanceof Error ? err.message : err}. Check \`autonomos status\` on the host.`,
        });
      }
    }
    throw err;
  }
}

// `autonomos migrate-from-pm2` — one-shot migration command for users who
// installed via the old `make prod` + pm2 flow. Stops pm2's autonomos process,
// deregisters it, saves pm2 state, then runs install-service to set up the
// new OS-native supervisor.
//
// Also invoked automatically by install.sh when pm2-managed autonomos is
// detected, so most users will never run this directly.

import { detectPm2Install, migrateFromPm2 } from "../lib/pm2.js";
import { runInstallServiceCommand } from "./install-service.js";

export async function runMigrateFromPm2Command(
  argv: readonly string[],
): Promise<number> {
  const detection = detectPm2Install();

  if (!detection.managed) {
    console.log("No pm2-managed autonomos detected. Nothing to migrate.");
    return 0;
  }

  console.log(
    `Detected ${detection.processes.length} pm2-managed autonomos process(es). Migrating...`,
  );
  if (detection.port !== undefined) {
    console.log(`  Preserving PORT=${detection.port} from pm2 setup.`);
  }
  const result = migrateFromPm2();
  if (!result.ok) {
    console.error(`✗ pm2 migration failed: ${result.message}`);
    return 1;
  }
  console.log(`✓ Stopped + deregistered ${result.stopped} pm2 process(es).`);

  console.log("Installing OS-native supervisor (launchd/systemd-user)...");
  // Carry pm2's PORT through to the new supervisor's ExecStart so existing
  // clients pointed at the old port keep working post-migration.
  const installArgs = [...argv, "--force"];
  if (
    detection.port !== undefined &&
    !installArgs.some((a) => a === "--port" || a.startsWith("--port="))
  ) {
    installArgs.push(`--port=${detection.port}`);
  }
  const installCode = await runInstallServiceCommand(installArgs);
  if (installCode !== 0) {
    console.error(
      "✗ install-service failed after pm2 migration. Your daemon is currently NOT running.\n" +
        "  Fix the install-service issue, then run `autonomos start` or re-run this command.",
    );
    return installCode;
  }
  console.log(
    "✓ Migration complete. autonomos is now under OS-native supervision.",
  );
  return 0;
}

/**
 * CI: do the INSTALLED agent CLIs still accept exactly the permission options
 * autonomOS offers? Exits 1, naming each dropped/renamed/new option, if not.
 *
 *   tsx scripts/check-cli-drift.ts [--require claude-code,codex,gemini-cli]
 *
 * No session is started and no auth is needed (runtimeProbe.ts: flag parsing,
 * config loading and the offline app-server schema only).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@autonomos/core";

async function main(): Promise<number> {
  // The server modules resolve a config dir at import; never the real one.
  process.env.AUTONOMOS_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "aos-drift-"));
  const { checkInstalledClis } = await import(
    "../packages/server/src/cliDrift.js"
  );

  const i = process.argv.indexOf("--require");
  const required =
    i >= 0 ? (process.argv[i + 1]?.split(",") as Provider[]) : undefined;

  const { checked, problems } = await checkInstalledClis({ required });
  for (const line of checked) console.log(`checked ${line}`);
  if (problems.length === 0) {
    console.log("OK: every installed CLI accepts exactly the offered options");
    return 0;
  }
  for (const p of problems)
    console.error(`::error title=CLI permission drift::${p}`);
  console.error(
    `\n${problems.length} problem(s). Update RUNTIME_PERMISSIONS (packages/core/src/types/runtimePermissions.ts) and the provider mapping, re-verify, then bump verifiedOn.`,
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

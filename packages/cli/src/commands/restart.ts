// `autonomos restart` — restart the installed OS-native service.
//
// Replaces `pm2 restart autonomos`. Asks the supervisor to cycle the daemon
// (launchctl kickstart / systemctl --user restart — see lib/service-control.ts).
// A restart only makes sense under a supervisor; a bare foreground `autonomos
// start` can't be re-backgrounded by the CLI.
//
// Exit codes:
//   0 — restart requested successfully
//   1 — restart failed
//   2 — no installed service (nothing to restart)

import {
  findInstalledService,
  restartService,
} from "../lib/service-control.js";

export async function runRestartCommand(): Promise<number> {
  const svc = findInstalledService();
  if (!svc) {
    console.error(
      `No installed service found.\n` +
        `\`autonomos restart\` cycles the OS-native supervisor; install it first ` +
        `with \`autonomos install-service\`.\n` +
        `(To restart a foreground server, stop it and run \`autonomos start\` again.)`,
    );
    return 2;
  }

  const res = restartService(svc);
  if (!res.ok) {
    console.error(
      `Restart failed: ${res.stderr.trim() || `exit ${res.exitCode}`}\n` +
        `If the service is in a bad state, re-run \`autonomos install-service --force\`.`,
    );
    return 1;
  }
  console.log(
    svc.platform === "darwin"
      ? "✓ Restarted via launchctl"
      : "✓ Restarted via systemctl --user",
  );
  return 0;
}

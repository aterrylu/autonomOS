// Print the REAL systemd unit (packages/cli service-templates) with the
// fixture server as its ExecStart. Usage: tsx render-unit.ts <tsx> <fixture> <logDir>
import { renderSystemdUserUnit } from "../../packages/cli/src/lib/service-templates.ts";

const [tsx, fixture, logDir] = process.argv.slice(2);
if (!tsx || !fixture || !logDir) {
  console.error("usage: render-unit.ts <tsx> <fixture> <logDir>");
  process.exit(2);
}
process.stdout.write(
  renderSystemdUserUnit({
    programArgs: [tsx, fixture],
    logDir,
    home: process.env.HOME ?? "/tmp",
    path: process.env.PATH ?? "/usr/bin:/bin",
  }),
);

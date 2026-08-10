// Service-supervisor templates, embedded as strings in the CLI binary
// (Tailscale's `install_darwin.go` pattern). The CLI substitutes paths at
// install time. Two platforms supported in Phase 1C:
//
//   macOS  → LaunchAgent in ~/Library/LaunchAgents/com.autonomos.daemon.plist
//   Linux  → systemd-user unit in ~/.config/systemd/user/autonomos.service
//
// Both run as the invoking user (no sudo). Both restart on failure. Both
// survive logout (via plist KeepAlive on mac, loginctl enable-linger on linux).
//
// LOGGING: the server owns its own rotating log (server/src/logger.ts tees
// stdout+stderr into $logDir/autonomos.log and rotates it). The supervisor must
// NOT also capture stdout to a growing file — two writers would corrupt it, and
// a supervisor-held fd can't be rotated from outside. So we send the
// supervisor's stdout to /dev/null and keep only a stderr backstop
// ($logDir/autonomos.boot.error.log) for failures BEFORE the logger attaches.
// The logger stops echoing stderr to this file once attached (it echoes stderr
// only on a TTY), so the backstop stays bounded — runtime errors live in the
// rotating autonomos.log instead. `autonomos logs` tails autonomos.log.
export const BOOT_ERROR_LOG = "autonomos.boot.error.log";

// ── Service identity (label / unit name) ─────────────────────────────────
//
// The launchd label and systemd unit name are the ADDRESS of the daemon in a
// per-user, GLOBAL namespace — `launchctl unload <file>` reads only the Label
// out of the file and then unloads whatever loaded job carries that label,
// regardless of where the file lives. That made HOME/path isolation useless
// as a test boundary: a hermetic harness that wrote units under an isolated
// prefix still took down the real daemon three times in two days (2026-08-08
// / 08-09) the moment any verb touched a file carrying the production label.
// See the test-label ADR (provisionally ADR-081).
//
// AUTONOMOS_SERVICE_LABEL overrides the identity everywhere at once — the
// rendered unit files, the filenames install/uninstall/find resolve, and
// every launchctl/systemctl target in service-control. The test harness sets
// it to `com.autonomos.daemon.test`; production leaves it unset. This is an
// env var rather than a flag so no verb can be forgotten.

export const DEFAULT_LAUNCHAGENT_LABEL = "com.autonomos.daemon";
export const DEFAULT_SYSTEMD_UNIT_NAME = "autonomos.service";

export function serviceLabel(): string {
  return process.env.AUTONOMOS_SERVICE_LABEL || DEFAULT_LAUNCHAGENT_LABEL;
}

export function launchAgentFilename(): string {
  return `${serviceLabel()}.plist`;
}

/**
 * The systemd unit name. Production keeps the historical `autonomos.service`
 * (existing installs address it by that name); an overridden label derives
 * the unit name from the label so a test harness can never collide with it.
 */
export function systemdUnitName(): string {
  const label = serviceLabel();
  return label === DEFAULT_LAUNCHAGENT_LABEL
    ? DEFAULT_SYSTEMD_UNIT_NAME
    : `${label}.service`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Shell-escape a single argument for embedding in a systemd ExecStart line.
 * systemd is space-separated; arguments containing spaces or special chars
 * must be quoted. We use POSIX single-quote escaping which is simple and
 * safe: any `'` inside becomes `'\''`.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/\-.=:]+$/.test(arg)) return arg; // safe characters
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export type LaunchAgentOptions = {
  /** Argv to invoke (e.g., ["/usr/local/bin/autonomos", "start"]) */
  programArgs: readonly string[];
  /** Directory for log files */
  logDir: string;
  /** User's $HOME, written into EnvironmentVariables */
  home: string;
  /** Value of $PATH to set in the daemon's environment */
  path: string;
  /**
   * launchd job label. Defaults to serviceLabel() (env-overridable). The
   * unit-sync heal passes the label RECOVERED from the installed file so a
   * re-render can never re-address a unit to a different job.
   */
  label?: string;
};

export function renderLaunchAgentPlist(opts: LaunchAgentOptions): string {
  const argsXml = opts.programArgs
    .map((a) => `        <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyLists-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(opts.label ?? serviceLabel())}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logDir)}/${BOOT_ERROR_LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${escapeXml(opts.home)}</string>
        <key>PATH</key>
        <string>${escapeXml(opts.path)}</string>
    </dict>
</dict>
</plist>
`;
}

export type SystemdUserUnitOptions = {
  /** Argv to invoke (e.g., ["/usr/local/bin/autonomos", "start"]) */
  programArgs: readonly string[];
  /** Directory for log files */
  logDir: string;
  /** User's $HOME */
  home: string;
  /** Value of $PATH to set in the daemon's environment */
  path: string;
};

export function renderSystemdUserUnit(opts: SystemdUserUnitOptions): string {
  const execStart = opts.programArgs.map(shellQuote).join(" ");
  return `[Unit]
Description=autonomOS server (agent orchestration platform)
After=default.target
# No start-limit: with the default StartLimitBurst, a bundle that crashes on
# boot (e.g. right after an upgrade) exhausts the burst and systemd STOPS
# restarting — Restart=always silently becomes permanent downtime. The upgrade
# flow's health gate + auto-rollback (ADR-077) is the safety net; the
# supervisor's job is to never give up.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5
StandardOutput=null
StandardError=append:${opts.logDir}/${BOOT_ERROR_LOG}
Environment=HOME=${opts.home}
Environment=PATH=${opts.path}

[Install]
WantedBy=default.target
`;
}

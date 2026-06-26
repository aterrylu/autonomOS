// Service-supervisor templates, embedded as strings in the CLI binary
// (Tailscale's `install_darwin.go` pattern). The CLI substitutes paths at
// install time. Two platforms supported in Phase 1C:
//
//   macOS  → LaunchAgent in ~/Library/LaunchAgents/com.autonomos.daemon.plist
//   Linux  → systemd-user unit in ~/.config/systemd/user/autonomos.service
//
// Both run as the invoking user (no sudo). Both restart on failure. Both
// survive logout (via plist KeepAlive on mac, loginctl enable-linger on linux).

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
    <string>com.autonomos.daemon</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(opts.logDir)}/autonomos.log</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(opts.logDir)}/autonomos.error.log</string>
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

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5
StandardOutput=append:${opts.logDir}/autonomos.log
StandardError=append:${opts.logDir}/autonomos.error.log
Environment=HOME=${opts.home}
Environment=PATH=${opts.path}

[Install]
WantedBy=default.target
`;
}

export const LAUNCHAGENT_LABEL = "com.autonomos.daemon";
export const LAUNCHAGENT_FILENAME = `${LAUNCHAGENT_LABEL}.plist`;
export const SYSTEMD_UNIT_NAME = "autonomos.service";

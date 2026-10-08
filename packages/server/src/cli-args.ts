// Minimal argv parser for the autonomos-server binary.
// No external dependency — handles --flag, --flag=value, --flag value forms.
//
// Recognized flags:
//   --port=N | --port N    Override the listen port (env PORT also works)
//   --host=H | --host H    Restrict the bind interface (env AUTONOMOS_HOST).
//                          Default: all interfaces — see run.ts:resolveBindHost.
//   --print-url            On listen, print a sign-in link
//                          (http://host:port/#token=…) to the terminal only
//   --allow-weak-token     Let a NEW install start with a weak token on a
//                          network bind (env AUTONOMOS_ALLOW_WEAK_TOKEN=1)
//   --help                 Print usage and exit 0

export type CliArgs = {
  port: number | undefined;
  host: string | undefined;
  printUrl: boolean;
  allowWeakToken: boolean;
  trustProxy: string | undefined;
  serveSocket: string | undefined;
  help: boolean;
};

const USAGE = `Usage: autonomos-server [options]

Options:
  --port=N        Listen on port N (default: 3000, env PORT)
  --host=H        Bind to interface H (env AUTONOMOS_HOST), or a comma list
                  like 127.0.0.1,100.x.y.z (put loopback first: the autonomos
                  CLI talks to localhost). Each further address gets its own
                  listener on the same port and is retried in the background
                  until it exists, e.g. a tailnet address before Tailscale is
                  up. Default: ALL interfaces, reachable on every network the
                  machine is on. Every API/WebSocket route requires the auth
                  token; only GET /api/host does not. /mcp and hook ingestion
                  live on the internal control socket ($configDir/control.sock).
  --print-url     After startup, print a sign-in link
                  (http://host:port/#token=…) — open it to sign in to the
                  dashboard. Printed to the terminal only, never the log file.
  --allow-weak-token
                  Let a NEW install start with an operator token under 32
                  characters on a network bind (env AUTONOMOS_ALLOW_WEAK_TOKEN=1).
                  Without it, such a first start is refused. Existing installs
                  are never refused, only warned. \`autonomos token rotate\`
                  replaces a weak token.
  --trust-proxy=tailscale
                  (env AUTONOMOS_TRUST_PROXY) Run behind \`tailscale serve\`:
                  autonomOS also listens on an owner-only unix socket, and a
                  request tailscale serve forwards there counts as coming from
                  the visitor's tailnet address, so per-device protections
                  work per device. The startup log and \`autonomos token
                  status\` print the \`tailscale serve --bg unix:<path>\`
                  command to run. Only allowed with a loopback --host
                  (127.0.0.1), or the network could reach it around serve.
  --serve-socket=PATH
                  (env AUTONOMOS_SERVE_SOCKET) Where that socket lives
                  (default: Tailscale's app-group folder on the App Store
                  Mac app, else <config dir>/serve.sock).
  --help          Print this message and exit
`;

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    port: undefined,
    host: undefined,
    printUrl: false,
    allowWeakToken: false,
    trustProxy: undefined,
    serveSocket: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--print-url") {
      args.printUrl = true;
      continue;
    }
    if (arg === "--allow-weak-token") {
      args.allowWeakToken = true;
      continue;
    }
    if (arg.startsWith("--trust-proxy=")) {
      args.trustProxy = arg.slice("--trust-proxy=".length);
      continue;
    }
    if (arg === "--trust-proxy") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--trust-proxy requires a value");
      args.trustProxy = next;
      continue;
    }
    if (arg.startsWith("--serve-socket=")) {
      args.serveSocket = arg.slice("--serve-socket=".length);
      if (!args.serveSocket) throw new Error("--serve-socket requires a path");
      continue;
    }
    if (arg === "--serve-socket") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--serve-socket requires a path");
      args.serveSocket = next;
      continue;
    }
    if (arg.startsWith("--port=")) {
      args.port = parsePort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--port") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--port requires a value");
      args.port = parsePort(next);
      continue;
    }
    if (arg.startsWith("--host=")) {
      args.host = parseHost(arg.slice("--host=".length));
      continue;
    }
    if (arg === "--host") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--host requires a value");
      args.host = parseHost(next);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }

  return args;
}

function parsePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid --port value: ${raw} (must be 0-65535)`);
  }
  return n;
}

// Reject empty/whitespace hosts rather than passing them to listen(), where an
// empty string silently means "all interfaces" — the opposite of this flag's
// safe default. Fail loudly instead of quietly exposing the port.
function parseHost(raw: string): string {
  const host = raw.trim();
  if (!host) {
    throw new Error(
      "Invalid --host value: must not be empty " +
        "(use --host=0.0.0.0 to bind all interfaces, or omit for loopback)",
    );
  }
  return host;
}

export function printUsage(): void {
  process.stdout.write(USAGE);
}

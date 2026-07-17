// Minimal argv parser for the autonomos-server binary.
// No external dependency — handles --flag, --flag=value, --flag value forms.
//
// Recognized flags:
//   --port=N | --port N    Override the listen port (env PORT also works)
//   --host=H | --host H    Override the bind interface (env AUTONOMOS_HOST).
//                          Defaults to loopback — see run.ts:resolveBindHost.
//   --print-url            On listen, print "URL: http://host:port  token: …"
//                          for easy copy-paste into a browser or client
//   --help                 Print usage and exit 0

export type CliArgs = {
  port: number | undefined;
  host: string | undefined;
  printUrl: boolean;
  help: boolean;
};

const USAGE = `Usage: autonomos-server [options]

Options:
  --port=N        Listen on port N (default: 3000, env PORT)
  --host=H        Bind to interface H (default: 127.0.0.1, env AUTONOMOS_HOST).
                  The default is loopback-only: the dashboard is reachable from
                  this machine but not from the network. Pass --host=0.0.0.0 to
                  expose it (e.g. a remote/always-on box you browse to), and only
                  on a network you trust: the API/WebSocket/MCP routes require the
                  auth token, but POST /api/hooks/* and GET /api/host are still
                  unauthenticated.
                  Prefer 0.0.0.0 over a specific IP — the post-install health
                  check and the running-server guard both probe localhost, so a
                  loopback-excluding bind reports a false install failure.
  --print-url     After startup, print a human-readable line:
                  "URL: http://host:port  token: …" for easy copy-paste
                  to connect a browser or client.
  --help          Print this message and exit
`;

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    port: undefined,
    host: undefined,
    printUrl: false,
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

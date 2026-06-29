// Minimal argv parser for the autonomos-server binary.
// No external dependency — handles --flag, --flag=value, --flag value forms.
//
// Recognized flags:
//   --port=N | --port N    Override the listen port (env PORT also works)
//   --print-url            On listen, print "URL: http://host:port  token: …"
//                          for easy copy-paste into a browser or client
//   --help                 Print usage and exit 0

export type CliArgs = {
  port: number | undefined;
  printUrl: boolean;
  help: boolean;
};

const USAGE = `Usage: autonomos-server [options]

Options:
  --port=N        Listen on port N (default: 3000, env PORT)
  --print-url     After startup, print a human-readable line:
                  "URL: http://host:port  token: …" for easy copy-paste
                  to connect a browser or client.
  --help          Print this message and exit
`;

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    port: undefined,
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

export function printUsage(): void {
  process.stdout.write(USAGE);
}

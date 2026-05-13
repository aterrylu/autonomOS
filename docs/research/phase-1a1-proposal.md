# Phase 1A.1 — Binary Buildable

> Foundation phase. Makes `autonomos-server` bundleable so Phase 1B (Desktop)
> can spawn it as a child process. Additive only — does NOT replace the
> existing `make prod + pm2` deployment.
>
> Status: SHIPPED with one deviation from the proposal. See "Findings" below.
>
> Scope: ~150-300 LOC.

## Findings during implementation (2026-05-12)

`bun build --compile` was the original plan, but hit a hard ABI incompatibility
between Bun 1.3.10 (ABI 137) and node-pty's prebuilt .node (ABI 141). This blocks
both `--compile` AND `--target=bun` (the Bun *runtime* can't load node-pty at
all, not just the compiled-binary path).

The Phase 1A.1 build pipeline therefore produces a **Node.js JS bundle** via
`bun build --target=node`, runnable via `node dist/<platform>/index.js`. Node
loads node-pty's prebuilt cleanly. The "single static binary" aspiration is
deferred until Bun's ABI catches up to node-pty OR we switch to Bun's native
PTY API (out of scope for 1A.1).

For Phase 1B (Electron desktop) this is exactly what's needed: Electron bundles
Node + this JS bundle + the dashboard, spawns it as a child process. Contract
is unchanged: stdout `AUTONOMOS_READY port=N` on boot, SIGTERM for shutdown,
localhost-only bind in embedded mode.

See [project_nodepty_bun_compile.md](../../../../.claude/projects/-Users-aterrylu-workspace-autonomOS/memory/project_nodepty_bun_compile.md) for the failure-mode details.

---

## Goal

Produce a single self-contained executable that runs the autonomOS server when invoked.

```bash
$ ./autonomos-server --port=7100
✓ autonomOS server listening on http://127.0.0.1:7100
```

That's it. No subcommands, no install logic, no upgrade logic — just a server binary.

---

## Out of scope (Phase 1C territory)

- CLI subcommand framework (`status`, `stop`, `upgrade`, `install-service`)
- `install.sh` web installer
- launchd / systemd-user templates
- pm2 migration code
- `POST /api/system/upgrade` endpoint
- Web-GUI upgrade button
- GitHub Releases pipeline for public distribution
- Replacing `make prod + pm2`

These all stay deferred to Phase 1C.

---

## File changes

```
packages/server/
├── src/index.ts              MODIFIED  Accept --port and --embedded argv flags
├── src/embedded-mode.ts      NEW       Sets up server for "spawned by parent"
│                                       behavior (write port to stdout for
│                                       parent process to read, exit on SIGTERM)
└── (build config)            MODIFIED  bun.toml or build script

packages/server/build/
├── build-binary.ts           NEW       Orchestrates bun build --compile
└── embed-dashboard.ts        NEW       Copies packages/dashboard/dist into the
                                       server's static-asset path before compile

package.json (root)           MODIFIED  Add `build:binary` script
```

No new packages. All new code lives inside `packages/server/`. Reason: this is a build-pipeline concern for the existing server, not a new product surface.

---

## Implementation steps

### Step 1: Argv parsing in server entry

```ts
// packages/server/src/index.ts (existing file, small additions)

const args = parseArgs(process.argv.slice(2));
const port = args.port ?? Number(process.env.PORT) ?? 3000;
const embedded = args.embedded ?? false;

if (embedded) {
  setupEmbeddedMode({ port });  // writes port to stdout, traps SIGTERM
}

// existing server bootstrap continues...
```

Minimal argv parser — no `commander` or `yargs` dependency for now. ~15 lines of manual parsing covering `--port=N`, `--port N`, `--embedded`, `--help`.

### Step 2: Embedded mode

```ts
// packages/server/src/embedded-mode.ts (new, ~30 lines)

export function setupEmbeddedMode({ port }) {
  // Write a line the parent (Electron main) can parse to learn the actual port
  process.stdout.write(`AUTONOMOS_READY port=${port}\n`);

  // Trap SIGTERM for graceful shutdown — parent will send this on app quit
  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}
```

This is the contract the Electron main process will rely on in Phase 1B: spawn the binary, read stdout for `AUTONOMOS_READY port=N`, connect a webview to `http://localhost:N`.

### Step 3: Embed dashboard build into binary

```ts
// packages/server/build/embed-dashboard.ts (new, ~40 lines)

// Before bun build --compile runs:
// 1. Confirm packages/dashboard/dist/ exists (else error: "run dashboard build first")
// 2. Copy dist/ contents into packages/server/src/static/ (gitignored)
// 3. The server's static-asset serving logic reads from that path
//
// bun build --compile then bundles src/static/ into the executable as embedded
// files, accessible at runtime via import.meta.dir + relative path.
```

Dashboard is built separately (`bun --filter dashboard build`), then copied. Keeps the dashboard build pipeline unchanged.

### Step 4: Build orchestration

```ts
// packages/server/build/build-binary.ts (new, ~50 lines)

const TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-x64',
  'bun-linux-arm64',
];

for (const target of TARGETS) {
  await $`bun build src/index.ts --compile --target=${target} --outfile=dist/autonomos-server-${target.replace('bun-', '')}`;
}
```

### Step 5: Root package.json script

```json
{
  "scripts": {
    "build:dashboard": "bun --filter @autonomos/dashboard build",
    "build:binary": "bun run build:dashboard && bun --filter @autonomos/server build:binary"
  }
}
```

A single `bun run build:binary` from repo root produces 4 platform binaries in `packages/server/dist/`.

---

## Dev testing isolation (CRITICAL)

The Phase 1A.1 binary must be testable on Terry's dev mac **without** disturbing:

- His running `make prod` deployment (port 3100, pm2-managed)
- His `make dev` workflow (port 3200-4000 hash-derived per cwd)
- His real config + state at `~/.autonomos/` (agents, sessions, schedules)
- Existing pm2 processes
- Existing LaunchAgents (none yet, but defensive)

### Isolation strategy

The existing codebase already supports environment-based isolation via `AUTONOMOS_CONFIG_DIR` (see `packages/server/src/configDir.ts:19`). The Makefile already uses this pattern for `make dev`. Phase 1A.1 testing will use the same mechanism.

```bash
# Three knobs together = complete isolation:
#   1. AUTONOMOS_CONFIG_DIR  → isolated state dir, no touching ~/.autonomos/
#   2. --port=7777           → distinct from 3100 (prod), dev hash-range, anything else
#   3. Run in foreground     → no service install, no pm2 register, easy to kill

AUTONOMOS_CONFIG_DIR=/tmp/autonomos-1a1-test \
  ./packages/server/dist/autonomos-server-darwin-arm64 \
  --port=7777
```

### Test runner script (committed in the worktree)

```bash
# scripts/test-1a1-isolated.sh  (NEW, ~30 lines)
#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="/tmp/autonomos-1a1-test"
TEST_PORT=7777
BIN="$(pwd)/packages/server/dist/autonomos-server-darwin-arm64"

# Clean previous test state
rm -rf "$TEST_DIR" && mkdir -p "$TEST_DIR"

# Verify nothing is listening on our test port
if lsof -ti:"$TEST_PORT" >/dev/null 2>&1; then
  echo "Port $TEST_PORT in use — refusing to start"; exit 1
fi

# Run in background, capture stdout
AUTONOMOS_CONFIG_DIR="$TEST_DIR" "$BIN" --port="$TEST_PORT" --embedded >/tmp/autonomos-1a1.log 2>&1 &
PID=$!

# Wait for AUTONOMOS_READY signal
for i in {1..20}; do
  if grep -q "AUTONOMOS_READY port=$TEST_PORT" /tmp/autonomos-1a1.log; then break; fi
  sleep 0.5
done

# Run verifications
curl -sf "http://localhost:$TEST_PORT/api/health" || { echo "health check failed"; kill $PID; exit 1; }
curl -sf "http://localhost:$TEST_PORT/" | grep -q "<html" || { echo "dashboard not served"; kill $PID; exit 1; }

# Test SIGTERM graceful shutdown
kill -TERM $PID
wait $PID 2>/dev/null
echo "✓ All checks passed. Test state at $TEST_DIR (safe to delete)."
```

This script does the full roundtrip — fresh state, isolated port, verify endpoints, verify graceful shutdown — without ever touching the real config or production setup.

### Worktree isolation (bonus)

Phase 1A.1 work happens in the existing worktree at `~/.claude-worktrees/autonomOS-terry-desktop-app/`. The Makefile's hash-derived port logic means this worktree's `make dev` already uses a different port from main. So even if I accidentally start `make dev` in the worktree, it can't collide with Terry's running prod or his main-checkout dev.

## Test plan

### Manual verification (run via the test script above)

1. `bun run build:binary` → confirms binaries appear in `packages/server/dist/`
2. `./scripts/test-1a1-isolated.sh` → automated runs through:
   - Stdout shows `AUTONOMOS_READY port=7777`
   - `curl http://localhost:7777/api/health` returns 200
   - `curl http://localhost:7777/` returns the dashboard HTML (embedded assets work)
   - SIGTERM shuts down cleanly within 2 seconds
3. Verify `~/.autonomos/` is untouched after test (`stat ~/.autonomos/sessions.json` mtime unchanged)
4. Verify `make prod` still works on port 3100
5. Verify `make dev` still works on its hash-derived port

### What I don't test in 1A.1

- Linux binary on actual Linux (cross-compile correctness is Phase 1C concern)
- WebSocket connections (need a fake session; deferred to Phase 1B where Electron exercises this)
- CI matrix builds (Phase 1C)
- Service install (Phase 1C)

---

## Risks and unknowns

| Risk | Likelihood | Mitigation |
|---|---|---|
| `bun build --compile` doesn't handle node-pty native bindings cleanly | Medium — node-pty has prebuilt binaries that may need special handling | Test early; if blocker, fall back to packaging node-pty separately alongside the binary |
| Dashboard asset embedding produces too-large binary | Low — dashboard build is ~5MB | Accept ~50-100MB total binary size |
| Cross-compilation issues (building linux binary on mac dev host) | Low — bun officially supports this | If broken, use Docker for cross-compile in Phase 1C |
| Existing `make dev` workflow disrupted | Low — additive only | Verify `make dev` and `make prod` both still work after the changes |

---

## Done definition

- `bun run build:binary` produces 4 platform binaries from repo root
- darwin-arm64 binary runs the server on dev mac, dashboard accessible via embedded assets
- Binary responds to SIGTERM gracefully
- `--port` and `--embedded` flags work as specified
- Existing `make dev` and `make prod` continue to work unchanged
- No new long-running dependencies added to `packages/server/package.json`

---

## After Phase 1A.1 lands

Phase 1B (Desktop) can begin. The Electron main process will:

```ts
const child = spawn(path.join(__dirname, 'autonomos-server'), [
  '--port=0',           // 0 = let OS pick free port
  '--embedded',
]);

child.stdout.on('data', (data) => {
  const match = data.toString().match(/AUTONOMOS_READY port=(\d+)/);
  if (match) {
    const port = Number(match[1]);
    browserWindow.loadURL(`http://localhost:${port}/`);
  }
});
```

That contract — stdout line announcing readiness + port, SIGTERM for shutdown — is the entire integration surface between Phase 1A.1 and Phase 1B.

#!/usr/bin/env bash
# Phase 1B.1 smoke test for autonomOS Desktop.
#
# Builds the app and verifies it can launch end-to-end:
#   1. Server bundle is up-to-date
#   2. packages/app builds (tsc → dist/main.js)
#   3. Launching `electron dist/main.js` causes the server to start
#      and emit AUTONOMOS_READY to stdout (we capture & inspect)
#   4. SIGTERM cleanly tears down both Electron and the server child
#
# Does NOT actually render the dashboard (would require a display in CI).
# That's verified manually by running `bun run dev` from packages/app/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/packages/app"
SERVER_LOG=/tmp/autonomos-app-smoke.log

cleanup() {
  if [[ -n "${ELEC_PID:-}" ]] && kill -0 "$ELEC_PID" 2>/dev/null; then
    kill -KILL "$ELEC_PID" 2>/dev/null || true
  fi
  rm -f "$SERVER_LOG"
}
trap 'rc=$?; if [[ $rc -ne 0 ]] && [[ -f "$SERVER_LOG" ]]; then echo ""; echo "=== electron+server log ==="; tail -50 "$SERVER_LOG"; echo "==========================="; fi; cleanup; exit $rc' EXIT

cd "$ROOT"

# ── claude stub for CI (server provider validation needs it) ────────────
if ! command -v claude >/dev/null 2>&1; then
  STUB_DIR=$(mktemp -d)
  cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
echo "claude (test stub)"
STUB
  chmod +x "$STUB_DIR/claude"
  export PATH="$STUB_DIR:$PATH"
  echo "==> Installed claude stub at $STUB_DIR"
fi

# ── ensure the server bundle exists ─────────────────────────────────────
echo "==> Building server bundle (if needed)"
if [[ ! -f "$ROOT/packages/server/dist/$(uname -s | tr '[:upper:]' '[:lower:]')-$([[ $(uname -m) == arm64 || $(uname -m) == aarch64 ]] && echo arm64 || echo x64)/index.js" ]]; then
  bun --filter @autonomos/dashboard build >/dev/null
  bun packages/server/build/embed-dashboard.ts >/dev/null
  bun packages/server/build/build-binary.ts >/dev/null
fi

# ── compile main.ts ─────────────────────────────────────────────────────
echo "==> Compiling Electron main process"
cd "$APP_DIR"
bunx tsc -p tsconfig.json

[[ -f dist/main.js ]] || { echo "✗ dist/main.js not produced"; exit 1; }
[[ -f dist/preload.js ]] || { echo "✗ dist/preload.js not produced"; exit 1; }
[[ -f dist/server-supervisor.js ]] || { echo "✗ dist/server-supervisor.js not produced"; exit 1; }
echo "==> ✓ Electron main process compiled"

# ── launch Electron headlessly and watch for AUTONOMOS_READY ────────────
# On macOS, electron will open a window. We use --no-sandbox + --disable-gpu
# to suppress GUI fully and just verify the child-process spawn path works.
echo "==> Launching Electron (headless mode for smoke test)"
if [[ "$(uname -s)" == "Darwin" ]]; then
  # Bare Electron call without `open -a`. Headless on macOS isn't truly
  # headless but we don't need rendering — just process spawn + stdout.
  ELEC_BIN="$APP_DIR/node_modules/.bin/electron"
else
  # Linux: use xvfb if available, else hope for the best.
  ELEC_BIN="xvfb-run -a $APP_DIR/node_modules/.bin/electron"
fi

# Skip macOS app-launch animations + DOM
ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
  $ELEC_BIN dist/main.js >"$SERVER_LOG" 2>&1 &
ELEC_PID=$!
echo "  Electron PID=$ELEC_PID, logging to $SERVER_LOG"

# ── wait for AUTONOMOS_READY ────────────────────────────────────────────
echo "==> Waiting for AUTONOMOS_READY from spawned server"
for i in $(seq 1 30); do
  if grep -q "AUTONOMOS_READY port=" "$SERVER_LOG" 2>/dev/null; then
    PORT=$(grep -oE 'AUTONOMOS_READY port=[0-9]+' "$SERVER_LOG" | tail -1 | sed 's/AUTONOMOS_READY port=//')
    echo "  ✓ Server ready on port $PORT (after ${i}s)"
    break
  fi
  if ! kill -0 "$ELEC_PID" 2>/dev/null; then
    echo "  ✗ Electron exited before server signaled ready"
    exit 1
  fi
  sleep 1
done

if ! grep -q "AUTONOMOS_READY port=" "$SERVER_LOG" 2>/dev/null; then
  echo "  ✗ Timed out waiting for AUTONOMOS_READY"
  exit 1
fi

# ── HTTP probe via the announced port ───────────────────────────────────
PORT=$(grep -oE 'AUTONOMOS_READY port=[0-9]+' "$SERVER_LOG" | tail -1 | sed 's/AUTONOMOS_READY port=//')
echo "==> Probing http://127.0.0.1:$PORT/api/host"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/host")
[[ "$HTTP_CODE" == "200" ]] || { echo "  ✗ /api/host returned $HTTP_CODE"; exit 1; }
echo "  ✓ /api/host returned 200"

# ── clean shutdown via SIGTERM ──────────────────────────────────────────
echo "==> Sending SIGTERM to Electron"
kill -TERM "$ELEC_PID"
for i in $(seq 1 15); do
  if ! kill -0 "$ELEC_PID" 2>/dev/null; then
    echo "  ✓ Electron exited cleanly (after ${i}s)"
    ELEC_PID=""
    break
  fi
  sleep 1
done

if [[ -n "${ELEC_PID:-}" ]] && kill -0 "$ELEC_PID" 2>/dev/null; then
  echo "  ✗ Electron did not exit on SIGTERM within 15s"
  exit 1
fi

# ── verify server child also exited (no orphan) ─────────────────────────
echo "==> Confirming no orphan server child on port $PORT"
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/host" 2>/dev/null; then
  echo "  ⚠️  Port $PORT still serving — possible orphan server child"
  exit 1
fi
echo "  ✓ Port released, no orphan"

echo ""
echo "✅ All Phase 1B.1 smoke checks passed."

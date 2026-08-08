#!/usr/bin/env bash
# L2 harness launcher — boots an ISOLATED perf server + vite dashboard and runs
# the Playwright perf specs against them. Never touches :3100 or ~/.autonomos.
#
#   ./perf/run-l2.sh                       # all specs, current defaults
#   ./perf/run-l2.sh terminal-switch      # one spec by grep
#   AUTONOMOS_WS_REPLAY_COALESCE=0 ./perf/run-l2.sh terminal-switch   # ablate
#
# Env knobs forwarded to the server: AUTONOMOS_WS_COALESCE[_MS|_BYTES],
# AUTONOMOS_WS_REPLAY_COALESCE[_BYTES]. PERF_HEADLESS=1 for headless Chromium
# (understates WebGL gains — headed is the honest default).

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"           # packages/server
DASH_DIR="$(cd "$SERVER_DIR/../dashboard" && pwd)"        # packages/dashboard

SERVER_PORT="${PERF_SERVER_PORT:-3199}"
VITE_PORT="${PERF_VITE_PORT:-5179}"
# Short path — the internal control socket lives here and Unix socket paths cap
# at ~104 chars.
CONFIG_DIR="$(mktemp -d /tmp/aos-perf.XXXXXX)"

# Kill a background job AND its descendants (`npx` nests the real node
# process under itself — killing only $! orphans the server, which then
# squats on the port and silently serves the NEXT run's measurements).
kill_tree() {
  local pid="$1"
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  kill_tree "${SERVER_PID:-0}"
  kill_tree "${VITE_PID:-0}"
  wait "${SERVER_PID:-}" "${VITE_PID:-}" 2>/dev/null || true
  rm -rf "$CONFIG_DIR"
}
trap cleanup EXIT INT TERM

# Pre-flight: refuse to run if either port is already held — otherwise the
# health check below would pass against a STALE server and every number
# measured would be from the wrong build.
for p in "$SERVER_PORT" "$VITE_PORT"; do
  if lsof -ti ":$p" >/dev/null 2>&1; then
    echo "[run-l2] port :$p already in use — a previous run's process is still alive." >&2
    echo "[run-l2] find it with: lsof -i :$p   — kill it by PID, then re-run." >&2
    exit 1
  fi
done

echo "[run-l2] config dir: $CONFIG_DIR  server :$SERVER_PORT  vite :$VITE_PORT"

(
  cd "$SERVER_DIR"
  AUTONOMOS_CONFIG_DIR="$CONFIG_DIR" \
  AUTONOMOS_PERF_ROUTES=1 \
  AUTONOMOS_PERF_NOAUTH=1 \
  PORT="$SERVER_PORT" \
    npx tsx src/index.ts >"$CONFIG_DIR/server.log" 2>&1
) &
SERVER_PID=$!

(
  cd "$DASH_DIR"
  VITE_API_PORT="$SERVER_PORT" \
    npx vite --port "$VITE_PORT" --strictPort >"$CONFIG_DIR/vite.log" 2>&1
) &
VITE_PID=$!

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$SERVER_PORT/api/perf/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[run-l2] server died — log:" >&2
    cat "$CONFIG_DIR/server.log" >&2
    exit 1
  fi
  sleep 0.5
done
curl -sf "http://127.0.0.1:$SERVER_PORT/api/perf/health" >/dev/null || {
  echo "[run-l2] server never became healthy — log:" >&2
  cat "$CONFIG_DIR/server.log" >&2
  exit 1
}

for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "[run-l2] both up — running Playwright"
cd "$DASH_DIR"
PERF_BASE="http://127.0.0.1:$VITE_PORT" \
  npx playwright test -c playwright.perf.config.ts ${1:+--grep "$1"}

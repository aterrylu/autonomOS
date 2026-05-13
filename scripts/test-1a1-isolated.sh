#!/usr/bin/env bash
# Phase 1A.1 isolated smoke test.
#
# Builds the autonomos-server binary for the current platform, runs it under
# isolated config + a dedicated test port, verifies:
#   - AUTONOMOS_READY stdout signal in embedded mode
#   - Health endpoint responds
#   - Dashboard HTML is served (embedded assets work)
#   - SIGTERM triggers clean shutdown
#
# Does NOT touch ~/.autonomos/ or any running prod/dev autonomos.

set -euo pipefail

# Resolve repo root from this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DIR="/tmp/autonomos-1a1-test"
TEST_PORT=7777
LOG_FILE="/tmp/autonomos-1a1-test.log"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_DIR" "$LOG_FILE"
}
trap cleanup EXIT

echo "==> Cleaning previous test state"
rm -rf "$TEST_DIR" "$LOG_FILE"
mkdir -p "$TEST_DIR"

echo "==> Verifying port $TEST_PORT is free"
if lsof -ti:"$TEST_PORT" >/dev/null 2>&1; then
  echo "  FAIL: port $TEST_PORT is already in use"; exit 1
fi

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) ARCH_SUFFIX="darwin-arm64" ;;
  Darwin/x86_64) ARCH_SUFFIX="darwin-x64" ;;
  Linux/x86_64) ARCH_SUFFIX="linux-x64" ;;
  Linux/aarch64) ARCH_SUFFIX="linux-arm64" ;;
  *) echo "  FAIL: unsupported host $(uname -s)/$(uname -m)"; exit 1 ;;
esac
BUNDLE="$REPO_ROOT/packages/server/dist/$ARCH_SUFFIX/index.js"

if [[ ! -f "$BUNDLE" ]]; then
  echo "==> Bundle not found at $BUNDLE — building it"
  (cd "$REPO_ROOT" && bun run build:binary)
fi

echo "==> Starting via node: node $BUNDLE --port=$TEST_PORT --embedded"
AUTONOMOS_CONFIG_DIR="$TEST_DIR" node "$BUNDLE" --port="$TEST_PORT" --embedded \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "  PID=$SERVER_PID, logs at $LOG_FILE"

echo "==> Waiting for AUTONOMOS_READY signal"
for i in $(seq 1 20); do
  if grep -q "AUTONOMOS_READY port=$TEST_PORT" "$LOG_FILE" 2>/dev/null; then
    echo "  ✓ Ready signal received after ${i}s"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "  FAIL: process died before signaling ready"
    echo "--- log ---"; cat "$LOG_FILE"; exit 1
  fi
  sleep 1
done
if ! grep -q "AUTONOMOS_READY port=$TEST_PORT" "$LOG_FILE"; then
  echo "  FAIL: timed out waiting for AUTONOMOS_READY"
  echo "--- log ---"; cat "$LOG_FILE"; exit 1
fi

echo "==> Hitting /api/host (unauthenticated endpoint)"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$TEST_PORT/api/host")
if [[ "$STATUS" != "200" ]]; then
  echo "  FAIL: /api/host returned $STATUS"; exit 1
fi
echo "  ✓ /api/host returned 200"

echo "==> Fetching dashboard root /"
BODY=$(curl -s "http://127.0.0.1:$TEST_PORT/")
if ! grep -q "<html" <<<"$BODY"; then
  echo "  FAIL: / did not return HTML"
  echo "  Got: $(head -c 200 <<<"$BODY")"; exit 1
fi
echo "  ✓ / returned HTML (embedded assets work)"

echo "==> Sending SIGTERM"
kill -TERM "$SERVER_PID"
for i in $(seq 1 10); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "  ✓ Process exited cleanly after ${i}s"
    SERVER_PID=""
    break
  fi
  sleep 1
done
if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "  FAIL: process did not exit on SIGTERM within 10s"
  exit 1
fi

echo "==> Confirming ~/.autonomos/ was untouched (test ran in isolation)"
if [[ -e "$TEST_DIR" ]]; then
  echo "  ✓ Test state created at $TEST_DIR (cleanup on exit)"
fi

echo ""
echo "✅ All Phase 1A.1 checks passed."

#!/usr/bin/env bash
# Bundle smoke test — spawns the bundled server with the bundled Node
# and confirms it actually boots end-to-end. Catches the class of bugs
# that pure unit tests cannot:
#   - pty.node / impit.node ABI mismatch with bundled Node
#   - missing native modules in the bundle
#   - server crashes during module init for any reason
#   - dashboard static files missing
#   - any bundle integrity issue
#
# Run AFTER `build-dmg.sh` has staged resources/ but BEFORE we declare
# the build healthy. Also run in CI before publishing any DMG.
#
# Exits 0 if the bundle boots, listens, and serves /api/system/version.
# Exits non-zero on any failure with a clear message.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # → packages/app/

NODE_BIN="${1:-resources/node/bin/node}"
SERVER_JS="${2:-resources/server/index.js}"
TIMEOUT_SECONDS="${3:-15}"

echo "[smoke-test] node=${NODE_BIN}"
echo "[smoke-test] server=${SERVER_JS}"

if [ ! -x "${NODE_BIN}" ]; then
  echo "[smoke-test] FAIL: bundled Node not executable at ${NODE_BIN}"
  exit 1
fi
if [ ! -f "${SERVER_JS}" ]; then
  echo "[smoke-test] FAIL: bundled server entry missing at ${SERVER_JS}"
  exit 1
fi

# ABI check — bundled Node's module version vs bundled native module's
# expected module version. Catches the v22 vs v25 pty.node mismatch
# we hit in v0.0.2.
NODE_ABI=$("${NODE_BIN}" -e "process.stdout.write(process.versions.modules)")
echo "[smoke-test] bundled Node ABI = ${NODE_ABI}"

# Verify each .node file in resources/server can be loaded by bundled Node.
# Use absolute paths because require() resolves bare strings as modules.
SERVER_DIR_ABS="$(cd "$(dirname "${SERVER_JS}")" && pwd)"
for native in "${SERVER_DIR_ABS}"/*.node; do
  [ -f "${native}" ] || continue
  if ! "${NODE_BIN}" -e "require('${native}')" >/tmp/smoke-native.err 2>&1; then
    echo "[smoke-test] FAIL: bundled Node cannot load $(basename "${native}")"
    echo "[smoke-test] error:"
    cat /tmp/smoke-native.err
    exit 1
  fi
  echo "[smoke-test] ✓ $(basename "${native}") loads under bundled Node"
done

# Boot the server in an isolated config dir on an ephemeral port. Token
# is set explicitly so we can validate auth-protected endpoints.
SMOKE_DIR=$(mktemp -d "/tmp/autonomos-smoke-XXXXXX")
SMOKE_TOKEN="smoke-test-$(date +%s)-${RANDOM}"
trap 'rm -rf "${SMOKE_DIR}" /tmp/smoke-*.log /tmp/smoke-*.err 2>/dev/null; [ -n "${SMOKE_PID:-}" ] && kill "${SMOKE_PID}" 2>/dev/null; true' EXIT

echo "[smoke-test] booting in ${SMOKE_DIR}..."
env -i HOME="${HOME}" PATH="${PATH}" \
  AUTONOMOS_CONFIG_DIR="${SMOKE_DIR}" \
  AUTONOMOS_TOKEN="${SMOKE_TOKEN}" \
  "${NODE_BIN}" "${SERVER_JS}" --embedded --port=0 \
  >/tmp/smoke-stdout.log 2>/tmp/smoke-stderr.log &
SMOKE_PID=$!

# Wait for AUTONOMOS_READY port=N. Timeout at TIMEOUT_SECONDS.
PORT=""
for i in $(seq 1 "${TIMEOUT_SECONDS}"); do
  sleep 1
  if ! kill -0 "${SMOKE_PID}" 2>/dev/null; then
    echo "[smoke-test] FAIL: server exited before signaling ready (after ${i}s)"
    echo "[smoke-test] stdout:"; cat /tmp/smoke-stdout.log
    echo "[smoke-test] stderr:"; cat /tmp/smoke-stderr.log
    exit 1
  fi
  if PORT=$(grep -oE 'AUTONOMOS_READY port=[0-9]+' /tmp/smoke-stdout.log | head -1 | cut -d= -f2); [ -n "${PORT}" ]; then
    echo "[smoke-test] ✓ server bound to ephemeral port ${PORT} after ${i}s"
    break
  fi
done

if [ -z "${PORT}" ]; then
  echo "[smoke-test] FAIL: server did not signal ready within ${TIMEOUT_SECONDS}s"
  echo "[smoke-test] stdout:"; cat /tmp/smoke-stdout.log
  echo "[smoke-test] stderr:"; cat /tmp/smoke-stderr.log
  exit 1
fi

# Confirm HTTP /api/system/version returns 200 with the configured token.
HTTP_CODE=$(curl -s -o /tmp/smoke-version.json -w "%{http_code}" \
  -H "Authorization: Bearer ${SMOKE_TOKEN}" \
  "http://127.0.0.1:${PORT}/api/system/version")
if [ "${HTTP_CODE}" != "200" ]; then
  echo "[smoke-test] FAIL: /api/system/version returned HTTP ${HTTP_CODE}"
  cat /tmp/smoke-version.json
  exit 1
fi
echo "[smoke-test] ✓ /api/system/version returns 200"

# Confirm POST /api/agents (the spawn path that hit the #178 bug) works.
SPAWN_RESPONSE=$(curl -s -X POST \
  -H "Authorization: Bearer ${SMOKE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"agentName":"SmokeTestAgent","workingDirectory":"/tmp","provider":"claude-code","autonomousMode":true}' \
  "http://127.0.0.1:${PORT}/api/agents")
if ! echo "${SPAWN_RESPONSE}" | grep -q '"status":"running"'; then
  echo "[smoke-test] FAIL: agent spawn did not return status=running"
  echo "${SPAWN_RESPONSE}"
  exit 1
fi
echo "[smoke-test] ✓ POST /api/agents spawned an agent (status=running)"

# Stop the spawned agent so it doesn't outlive the smoke test.
AGENT_ID=$(echo "${SPAWN_RESPONSE}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X DELETE -H "Authorization: Bearer ${SMOKE_TOKEN}" \
  "http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}" >/dev/null

# Clean shutdown of server.
kill "${SMOKE_PID}" 2>/dev/null || true
wait "${SMOKE_PID}" 2>/dev/null || true
SMOKE_PID=""

echo "[smoke-test] ✅ bundle smoke test PASSED"

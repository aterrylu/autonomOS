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

# Bundle-completeness check for runtime-loaded .mjs scripts. These are
# referenced by PATH (not import), so the bundler omits them and the server
# boots fine WITHOUT them — the failures are silent and downstream: spawned
# sessions get a statusLine command pointing at a missing file (CC swallows
# the error → no statusline), and the per-agent MCP channel-server subprocess
# never starts (agent send/create_agent tools dead). The list comes from the
# runtime-scripts.manifest that stageRuntimeScripts() (build-binary.ts) writes
# from RUNTIME_SCRIPTS — so the check tracks the staging list automatically.
MANIFEST="${SERVER_DIR_ABS}/runtime-scripts.manifest"
if [ ! -s "${MANIFEST}" ]; then
  echo "[smoke-test] FAIL: runtime-scripts.manifest missing or empty in bundle"
  echo "[smoke-test] check stageRuntimeScripts() in build-binary.ts"
  exit 1
fi
while IFS= read -r script; do
  [ -n "${script}" ] || continue
  if [ ! -f "${SERVER_DIR_ABS}/${script}" ]; then
    echo "[smoke-test] FAIL: runtime script missing from bundle: ${script}"
    echo "[smoke-test] check stageRuntimeScripts() in build-binary.ts"
    exit 1
  fi
  echo "[smoke-test] ✓ runtime script present: ${script}"
done < "${MANIFEST}"

# Universal-binary slice check. When SMOKE_EXPECT_UNIVERSAL=1 (the release CI
# building the universal2 DMG), every bundled native module AND the bundled
# Node binary MUST contain BOTH x86_64 and arm64 slices — otherwise the DMG
# would ship broken on one architecture and an arm64-only load check (above)
# would not catch it. Running the x64 slice for real needs Rosetta (absent on
# arm64 CI runners); the release workflow's x64-runner job covers native
# execution. Here we statically assert the slices are present.
if [ "${SMOKE_EXPECT_UNIVERSAL:-0}" = "1" ]; then
  check_universal() {
    local f="$1"
    local arches
    arches="$(lipo -info "${f}" 2>/dev/null | sed 's/.*: //')"
    if ! echo "${arches}" | grep -q "x86_64" || ! echo "${arches}" | grep -q "arm64"; then
      echo "[smoke-test] FAIL: ${f} is not universal — slices: '${arches}'"
      exit 1
    fi
    echo "[smoke-test] ✓ universal ($(echo "${arches}" | tr -s ' ')): $(basename "${f}")"
  }
  check_universal "${NODE_BIN}"
  for native in "${SERVER_DIR_ABS}"/*.node; do
    [ -f "${native}" ] && check_universal "${native}"
  done
  # node-pty's spawn-helper is a Mach-O executable (not a .node) that the server
  # posix_spawn()s to start agents — it MUST be universal too, or agent spawn
  # dies on the other arch with "posix_spawnp failed."
  if [ -f "${SERVER_DIR_ABS}/spawn-helper" ]; then
    check_universal "${SERVER_DIR_ABS}/spawn-helper"
  else
    echo "[smoke-test] FAIL: spawn-helper missing from bundle — agent spawn will fail"
    exit 1
  fi
fi

# Boot the server in an isolated config dir on an ephemeral port. Token
# is set explicitly so we can validate auth-protected endpoints.
SMOKE_DIR=$(mktemp -d "/tmp/autonomos-smoke-XXXXXX")
SMOKE_TOKEN="smoke-test-$(date +%s)-${RANDOM}"
trap 'rm -rf "${SMOKE_DIR}" /tmp/smoke-*.log /tmp/smoke-*.err 2>/dev/null; [ -n "${SMOKE_PID:-}" ] && kill "${SMOKE_PID}" 2>/dev/null; true' EXIT

# The server's startup self-check requires a `claude` binary (the default
# provider) on PATH or it exits. CI runners don't ship Claude Code, so we
# drop a stub `claude` that simply blocks — enough to satisfy the binary
# check AND to be spawned under a PTY for the agent-spawn assertion below
# (which validates the server's spawn wiring, not Claude itself).
STUB_BIN="${SMOKE_DIR}/stub-bin"
mkdir -p "${STUB_BIN}"
printf '#!/bin/sh\nexec sleep 3600\n' > "${STUB_BIN}/claude"
chmod +x "${STUB_BIN}/claude"

echo "[smoke-test] booting in ${SMOKE_DIR}..."
env -i HOME="${HOME}" PATH="${STUB_BIN}:${PATH}" \
  AUTONOMOS_CONFIG_DIR="${SMOKE_DIR}" \
  AUTONOMOS_TOKEN="${SMOKE_TOKEN}" \
  IMPIT_VERBOSE=1 \
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
  if PORT=$(grep -oE 'AUTONOMOS_READY port=[0-9]+' /tmp/smoke-stdout.log | head -1 | cut -d= -f2); [ -n "${PORT}" ] && [ "${PORT}" -gt 0 ]; then
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

# Validate the auth-cookie bootstrap path the Desktop uses. The Desktop's
# webview POSTs to /auth with the token, server sets an httpOnly cookie,
# subsequent fetches authenticate via the cookie. This is what makes the
# "Try it out" + Built-in dashboards skip the login prompt. If this regresses,
# users will see "Enter your access token to continue" — silently breaking
# the embedded-server UX in a way the Bearer-only tests above do NOT catch.
AUTH_HEADERS=$(curl -s -i -X POST \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"${SMOKE_TOKEN}\"}" \
  "http://127.0.0.1:${PORT}/auth" | tr -d '\r')
if ! echo "${AUTH_HEADERS}" | head -1 | grep -q "200 OK"; then
  echo "[smoke-test] FAIL: POST /auth did not return 200"
  echo "${AUTH_HEADERS}"
  exit 1
fi
SET_COOKIE=$(echo "${AUTH_HEADERS}" | awk -F': ' 'tolower($1)=="set-cookie"{print $2; exit}')
if [ -z "${SET_COOKIE}" ]; then
  echo "[smoke-test] FAIL: POST /auth did not Set-Cookie"
  exit 1
fi
COOKIE_VALUE=$(echo "${SET_COOKIE}" | awk -F';' '{print $1}')
if ! echo "${SET_COOKIE}" | grep -qi "httponly"; then
  echo "[smoke-test] FAIL: auth cookie missing HttpOnly"
  exit 1
fi
if ! echo "${SET_COOKIE}" | grep -qi "samesite=lax"; then
  echo "[smoke-test] FAIL: auth cookie missing SameSite=Lax"
  exit 1
fi
echo "[smoke-test] ✓ POST /auth sets HttpOnly + SameSite=Lax cookie"

# With ONLY the cookie (no Bearer header), /api/agents must still
# authenticate. This is the exact path the embedded-server dashboard hits
# on first load — if it fails, the user sees the login form.
COOKIE_CODE=$(curl -s -o /tmp/smoke-cookie.json -w "%{http_code}" \
  -H "Cookie: ${COOKIE_VALUE}" \
  "http://127.0.0.1:${PORT}/api/agents")
if [ "${COOKIE_CODE}" != "200" ]; then
  echo "[smoke-test] FAIL: GET /api/agents with auth cookie returned ${COOKIE_CODE}"
  cat /tmp/smoke-cookie.json
  exit 1
fi
echo "[smoke-test] ✓ GET /api/agents authenticates via cookie alone"

# And it must REJECT requests with no cookie + no Bearer (regression guard
# against accidental auth bypass).
NOAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "http://127.0.0.1:${PORT}/api/agents")
if [ "${NOAUTH_CODE}" != "401" ]; then
  echo "[smoke-test] FAIL: GET /api/agents WITHOUT auth returned ${NOAUTH_CODE} (expected 401)"
  exit 1
fi
echo "[smoke-test] ✓ unauthenticated requests are rejected (401)"

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

# Liveness gate — the spawn RESPONSE returning status=running is NOT proof the
# agent is actually alive. node-pty's posix_spawn() of its spawn-helper returns
# success before the helper child fails, so a broken/missing spawn-helper yields
# a zombie that still reports "running" in the initial response. (This exact
# false pass hid the bundled spawn-helper being staged at a build-machine path
# that doesn't exist in the shipped .app — agent spawn was silently dead.) Assert
# the agent is STILL running a moment later: if the PTY died, deriveStatus() moves
# it off "running" (exited) or the record disappears.
# Suppress python's traceback (2>/dev/null) and route a parse failure through the
# script's own FAIL message instead of dying mid-pipe with a raw stack trace.
AGENT_ID=$(echo "${SPAWN_RESPONSE}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])" 2>/dev/null) || {
  echo "[smoke-test] FAIL: could not parse agent id from spawn response"
  echo "${SPAWN_RESPONSE}"
  exit 1
}
sleep 2
LIVE_STATUS=$(curl -s -H "Authorization: Bearer ${SMOKE_TOKEN}" \
  "http://127.0.0.1:${PORT}/api/agents" \
  | python3 -c "import sys,json;a=[x for x in json.load(sys.stdin) if x['id']=='${AGENT_ID}'];print(a[0]['status'] if a else 'GONE')" 2>/dev/null) || {
  echo "[smoke-test] FAIL: could not parse /api/agents response for liveness check"
  echo "[smoke-test] server stderr:"; tail -20 /tmp/smoke-stderr.log
  exit 1
}
if [ "${LIVE_STATUS}" != "running" ]; then
  echo "[smoke-test] FAIL: agent did not stay alive (status=${LIVE_STATUS} after 2s)"
  echo "[smoke-test] This means node-pty's spawn-helper could not be exec'd —"
  echo "[smoke-test] check spawn-helper staging + path repoint in build-binary.ts."
  echo "[smoke-test] server stderr:"; tail -20 /tmp/smoke-stderr.log
  exit 1
fi
echo "[smoke-test] ✓ agent is still alive 2s after spawn (spawn-helper works)"

# Stop the spawned agent so it doesn't outlive the smoke test.
curl -s -X DELETE -H "Authorization: Bearer ${SMOKE_TOKEN}" \
  "http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}" >/dev/null

# Clean shutdown of server.
kill "${SMOKE_PID}" 2>/dev/null || true
wait "${SMOKE_PID}" 2>/dev/null || true
SMOKE_PID=""

echo "[smoke-test] ✅ bundle smoke test PASSED"

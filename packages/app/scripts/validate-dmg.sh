#!/usr/bin/env bash
# End-to-end DMG validation. Mounts the DMG, launches the .app with the
# CDP remote-debugging port enabled, drives the Welcome screen via CDP
# scripting, clicks "Try it out", waits for the dashboard to load, and
# asserts that:
#   - the dashboard rendered WITHOUT the login form (auto-auth works)
#   - the Create Agent panel auto-opened (first-run UX fired)
#   - Dispatcher is pre-selected with the Recommended badge
#
# Captures a screenshot for visual proof. Exits non-zero on any regression.
#
# Usage:
#   bash scripts/validate-dmg.sh <path/to/the.dmg>
#
# This is the complement to smoke-test-bundle.sh — that one validates the
# bundle CAN boot, this one validates the user-visible flow ACTUALLY works.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."  # → packages/app/

DMG="${1:-}"
if [ -z "${DMG}" ] || [ ! -f "${DMG}" ]; then
  echo "[validate-dmg] usage: $0 <path/to/the.dmg>" >&2
  exit 1
fi

# Detach any lingering mounts + processes so this run starts clean.
for v in /Volumes/autonomOS*; do hdiutil detach "$v" -force 2>/dev/null || true; done
pkill -9 -f "autonomOS Helper" 2>/dev/null || true
pkill -9 -f "autonomOS.app/Contents/MacOS/autonomOS" 2>/dev/null || true
sleep 1

# Mount + launch with CDP debugging port.
hdiutil attach -nobrowse "${DMG}" >/dev/null
APP=""
for v in /Volumes/autonomOS*; do
  if [ -d "$v/autonomOS.app" ]; then APP="$v/autonomOS.app"; break; fi
done
if [ -z "${APP}" ]; then
  echo "[validate-dmg] FAIL: autonomOS.app not found in any mounted volume" >&2
  exit 1
fi
echo "[validate-dmg] launching ${APP}"

PORT=9222

# The bundled server's startup preflight exits(1) if no provider binary (claude/
# codex/gemini) is on PATH — which is the case on a CI runner (and on a fresh
# user Mac without Claude Code). When Try-it-out spawns the ephemeral server, it
# would die at preflight → no AUTONOMOS_READY → the connection window never opens.
# Drop a stub `claude` on PATH (same trick smoke-test-bundle.sh uses) so the
# ephemeral server boots; the Electron app + its spawned server inherit this PATH.
STUB_BIN="$(mktemp -d)/stub-bin"
mkdir -p "${STUB_BIN}"
printf '#!/bin/sh\nexec sleep 86400\n' > "${STUB_BIN}/claude"
chmod +x "${STUB_BIN}/claude"
export PATH="${STUB_BIN}:${PATH}"

trap 'pkill -9 -f "autonomOS.app/Contents/MacOS/autonomOS" 2>/dev/null || true; for v in /Volumes/autonomOS*; do hdiutil detach "$v" -force 2>/dev/null || true; done; rm -rf "$(dirname "${STUB_BIN}")" 2>/dev/null || true' EXIT

# ELECTRON_ENABLE_LOGGING=1 surfaces the Electron MAIN console.* to stdout.
ELECTRON_ENABLE_LOGGING=1 "${APP}/Contents/MacOS/autonomOS" \
  --remote-debugging-port=${PORT} >/tmp/validate-dmg-app.log 2>&1 &
APP_PID=$!

# Wait for CDP to be reachable.
for i in $(seq 1 30); do
  sleep 0.5
  if curl -s -f "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[validate-dmg] CDP ready after $(echo "$i * 0.5" | bc)s"
    break
  fi
done
if ! curl -s -f "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[validate-dmg] FAIL: CDP never came up at localhost:${PORT}" >&2
  exit 1
fi

# Drive the app via CDP. Node has built-in WebSocket since v22.
# `|| EXIT=$?` so a CDP failure doesn't trip `set -e` before we print diagnostics.
EXIT=0
node scripts/validate-dmg-cdp.mjs "http://localhost:${PORT}" || EXIT=$?

if [ "${EXIT}" = "0" ]; then
  echo "[validate-dmg] ✅ DMG validation PASSED"
else
  echo "[validate-dmg] ❌ DMG validation FAILED" >&2
  # Diagnostics — surface WHY (esp. headless-CI failures where Try-it-out's
  # ephemeral server spawn never opens the connection window). The app's own
  # stdout/stderr (server-supervisor spawn, ephemeral server boot) is the key
  # signal and is otherwise invisible in CI.
  echo "── app log (/tmp/validate-dmg-app.log, tail) ──────────────────" >&2
  # Distinguish "log exists but empty" from "log missing / /tmp unwritable" —
  # the app is launched with >/tmp/...log, so a missing file points at the
  # redirect failing, not at a silent app.
  if [ -s /tmp/validate-dmg-app.log ]; then
    tail -150 /tmp/validate-dmg-app.log >&2
  elif [ -f /tmp/validate-dmg-app.log ]; then
    echo "(app log exists but is empty — app produced no stdout/stderr)" >&2
  else
    echo "(app log missing — check /tmp writability on the runner)" >&2
  fi
  echo "── CDP targets at failure (which windows exist?) ──────────────" >&2
  # Capture raw first so we can tell "CDP socket dead" (empty/curl error) from
  # "python3 missing / JSON malformed" — the swallowed-pipe version rendered
  # both as one opaque message, defeating the diagnostic's whole purpose.
  CDP_RAW="$(curl -s "http://localhost:${PORT}/json/list" 2>&1 || true)"
  if [ -z "${CDP_RAW}" ]; then
    echo "(CDP /json/list returned nothing — debug socket likely dead)" >&2
  else
    printf '%s' "${CDP_RAW}" \
      | python3 -c "import sys,json;[print(' •',t.get('type'),'—',t.get('title'),'—',t.get('url','')[:80]) for t in json.load(sys.stdin)]" >&2 \
      || { echo "(could not parse CDP targets — python3 present? raw below)" >&2; echo "${CDP_RAW:0:500}" >&2; }
  fi
  echo "───────────────────────────────────────────────────────────────" >&2
fi
exit ${EXIT}

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
trap 'pkill -9 -f "autonomOS.app/Contents/MacOS/autonomOS" 2>/dev/null || true; for v in /Volumes/autonomOS*; do hdiutil detach "$v" -force 2>/dev/null || true; done' EXIT

"${APP}/Contents/MacOS/autonomOS" --remote-debugging-port=${PORT} >/tmp/validate-dmg-app.log 2>&1 &
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
node scripts/validate-dmg-cdp.mjs "http://localhost:${PORT}"
EXIT=$?

if [ "${EXIT}" = "0" ]; then
  echo "[validate-dmg] ✅ DMG validation PASSED"
else
  echo "[validate-dmg] ❌ DMG validation FAILED" >&2
fi
exit ${EXIT}

#!/usr/bin/env bash
# End-to-end DMG validation. Mounts the DMG, launches the .app with the
# CDP remote-debugging port enabled, drives the Welcome screen via CDP
# scripting, clicks "Try it out", waits for the dashboard to load, and
# asserts that:
#   - the dashboard rendered WITHOUT the login form (auto-auth works)
#   - the Create Agent panel auto-opened (first-run UX fired)
#   - Dispatcher is pre-selected with the Recommended badge
#
# Then (Phase 2) relaunches on the idle Welcome screen and runs an idle-CPU
# peg-detector: samples the whole app process tree's CPU over a 10s idle window
# and fails if it exceeds ~80% of one core — catching the #176 GPU-compositor
# peg class (which CDP's JS-timing metrics can't see). Exits non-zero on any
# regression.
#
# Usage:
#   bash scripts/validate-dmg.sh <path/to/the.dmg>
#   CPU_THRESHOLD_PCT=80 CPU_WINDOW_SECS=10 bash scripts/validate-dmg.sh <dmg>
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

trap 'pkill -9 -f "autonomOS.app/Contents/MacOS/autonomOS" 2>/dev/null || true; pkill -9 -f "autonomOS Helper" 2>/dev/null || true; for v in /Volumes/autonomOS*; do hdiutil detach "$v" -force 2>/dev/null || true; done; rm -rf "$(dirname "${STUB_BIN}")" 2>/dev/null || true' EXIT

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

if [ "${EXIT}" != "0" ]; then
  echo "[validate-dmg] ❌ functional validation FAILED" >&2
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
  exit ${EXIT}
fi
echo "[validate-dmg] ✅ functional validation PASSED"

# ── Phase 2: idle-renderer CPU peg-detector (#176 class) ─────────────────
# The #176 bug pegged the GPU compositor at ~195% (≈2 cores) on an IDLE Welcome
# window — zero JS, pure compositor work from macOS vibrancy stacked under CSS
# backdrop-filter. That class is invisible to CDP's JS-timing metrics, so we
# measure OS-level process CPU instead. This is a PEG-DETECTOR, not a tight
# budget: healthy idle is ~5-45% of one core; the bug was ~195%. The 80%
# threshold sits in that wide empty gap, so it's robust to shared-runner noise
# while still catching a real peg from any cause.
CPU_WINDOW_SECS="${CPU_WINDOW_SECS:-10}"
CPU_THRESHOLD_PCT="${CPU_THRESHOLD_PCT:-80}"

# Sum cumulative CPU seconds across every process in the app bundle (main +
# renderers + GPU + helpers). Every process's argv begins with a path under
# "${APP}/..." so a literal grep matches the whole tree; the TIME column is
# cumulative CPU time as [[DD-]HH:]MM:SS[.ss].
app_cpu_seconds() {
  # `|| true` on the grep: no match (app not running) must yield "0.00", not a
  # pipeline failure that `set -e` would abort the assignment on before the
  # caller's guard can report it cleanly.
  ps -axo time=,command= 2>/dev/null \
    | { grep -F "${APP}" || true; } \
    | awk '{
        t = $1; gsub(/-/, ":", t); n = split(t, a, ":");
        s = a[n];
        if (n >= 2) s += a[n-1] * 60;
        if (n >= 3) s += a[n-2] * 3600;
        if (n >= 4) s += a[n-3] * 86400;
        sum += s;
      } END { printf "%.2f", sum + 0 }'
}

# Tail a log, distinguishing "empty" from "missing" (redirect failed / /tmp
# unwritable) — same diagnostic discipline as the functional-failure path.
dump_cpu_log() {
  if [ -s /tmp/validate-dmg-cpu.log ]; then
    tail -40 /tmp/validate-dmg-cpu.log >&2
  elif [ -f /tmp/validate-dmg-cpu.log ]; then
    echo "(cpu log exists but is empty — app produced no stdout/stderr)" >&2
  else
    echo "(cpu log missing — check /tmp writability on the runner)" >&2
  fi
}

measure_idle_cpu() {
  echo "[cpu] idle-renderer CPU peg-detector: ${CPU_WINDOW_SECS}s window, fail >${CPU_THRESHOLD_PCT}% of one core"
  # Clean slate. CRITICAL for measurement soundness: kill the functional instance
  # AND its Electron Helper processes (GPU/Renderer/Network — their argv embeds
  # the bundle path, so `pkill -f "${APP}"` reaps them), then WAIT until none
  # remain. Cumulative CPU-seconds are per-process, so a stale helper that's
  # present at the t0 sample but exits before t1 would drop out and make `delta`
  # negative — silently masking a real peg as a pass. A clean, stable process set
  # is the only way the sum-of-cumulative-time measurement is valid.
  pkill -9 -f "${APP}" 2>/dev/null || true
  pkill -9 -f "autonomOS Helper" 2>/dev/null || true
  for _ in $(seq 1 20); do
    awk "BEGIN{exit !($(app_cpu_seconds) > 0)}" || break  # >0 → still dying, wait
    sleep 0.5
  done

  # Relaunch fresh, sit on the idle Welcome screen (no CDP driving — the #176
  # scenario). Track the PID so the EXIT trap reaps this instance too.
  ELECTRON_ENABLE_LOGGING=1 "${APP}/Contents/MacOS/autonomOS" >/tmp/validate-dmg-cpu.log 2>&1 &
  APP_PID2=$!
  sleep 5  # let the Welcome window render and the renderer settle

  # Split declaration from assignment: `local t0=$(...)` would mask a command-
  # substitution failure (local's own exit status is always 0) under `set -e`.
  local t0 t1 delta pct
  t0="$(app_cpu_seconds)"
  sleep "${CPU_WINDOW_SECS}"
  t1="$(app_cpu_seconds)"

  # Fail closed: t1<=0 means no app processes were sampled — the relaunch crashed
  # or never rendered. Never report 0% and pass.
  if awk "BEGIN{exit !(${t1} <= 0)}"; then
    echo "[cpu] ❌ FAIL: sampled no app-tree CPU (t1=${t1}s) — did the app relaunch + render?" >&2
    dump_cpu_log
    return 1
  fi

  delta="$(awk "BEGIN{printf \"%.2f\", ${t1} - ${t0}}")"
  # Fail closed on a negative delta: the process set changed mid-sample (a helper
  # exited), so the cumulative-time measurement is unsound — don't let an
  # accounting artifact read as a healthy pass.
  if awk "BEGIN{exit !(${delta} < 0)}"; then
    echo "[cpu] ❌ FAIL: negative CPU delta (${delta}s) — process set changed mid-sample, measurement unsound" >&2
    dump_cpu_log
    return 1
  fi

  pct="$(awk "BEGIN{printf \"%.1f\", (${delta} / ${CPU_WINDOW_SECS}) * 100}")"
  echo "[cpu] app tree consumed ${delta}s CPU over ${CPU_WINDOW_SECS}s idle → ${pct}% of one core"

  if awk "BEGIN{exit !(${pct} > ${CPU_THRESHOLD_PCT})}"; then
    echo "[cpu] ❌ idle CPU ${pct}% exceeds ${CPU_THRESHOLD_PCT}% — likely a compositor/render peg (cf. #176)" >&2
    return 1
  fi
  echo "[cpu] ✓ idle CPU within budget (${pct}% ≤ ${CPU_THRESHOLD_PCT}%)"
  return 0
}

measure_idle_cpu || EXIT=$?
if [ "${EXIT}" = "0" ]; then
  echo "[validate-dmg] ✅ DMG validation PASSED (functional + idle-CPU)"
else
  echo "[validate-dmg] ❌ DMG validation FAILED (idle-CPU gate)" >&2
fi
exit ${EXIT}

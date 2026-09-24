#!/usr/bin/env bash
# Machine-wide lock around the lefthook pre-push CI gate.
#
#   scripts/ci-gate-lock.sh <command> [args...]
#
# Every push runs the full `make check`, and a full test run fans out to about
# one process per core. When several agents push at once, their gates overlap
# and saturate the box (load avg 24-35 measured on 2026-09-24), which slows
# everything on it, the live server included, and produced timing-only test
# flakes. With this lock, gates QUEUE instead of overlapping: each one runs
# uncontended, and total throughput stays about the same.
#
# - The lock is a kernel lock on an open file (flock on Linux, lockf on macOS).
#   It is released when the holder's fd closes, so a crashed or killed gate
#   never wedges later pushes.
# - A waiter gives up after AUTONOMOS_CI_GATE_LOCK_TIMEOUT seconds (default 20
#   min) with a message naming the holder, rather than hanging a push forever.
# - The path is a FIXED machine-wide file, deliberately not $TMPDIR: agent
#   sessions each get their own sandboxed TMPDIR, so a TMPDIR lock would never
#   be shared between them.
# - With neither tool available it runs the command unlocked, with a warning.
#   The lock is a courtesy to the box, never a reason a push can't happen.

set -uo pipefail

LOCK="${AUTONOMOS_CI_GATE_LOCK_PATH:-/tmp/autonomos-ci-gate.lock}"
TIMEOUT="${AUTONOMOS_CI_GATE_LOCK_TIMEOUT:-1200}"
BUSY=75 # EX_TEMPFAIL: lockf's "lock unavailable" code, flock is told to match

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi

if command -v flock >/dev/null 2>&1; then
  probe() { flock -n -E "$BUSY" "$LOCK" true; }
  run_locked() { flock -w "$TIMEOUT" -E "$BUSY" "$LOCK" "$@"; }
elif command -v lockf >/dev/null 2>&1; then
  probe() { lockf -k -t 0 "$LOCK" true; }
  run_locked() { lockf -k -t "$TIMEOUT" "$LOCK" "$@"; }
else
  echo "[ci-gate] neither flock nor lockf found; running WITHOUT the machine-wide lock" >&2
  exec "$@"
fi

holder() {
  local pids
  pids=$(lsof -t "$LOCK" 2>/dev/null | paste -sd, -)
  [ -n "$pids" ] && ps -o pid=,command= -p "$pids" 2>/dev/null | head -3
}

# Probe only decides whether to announce the wait. If the lock is taken
# between the probe and the real acquire, we just wait without the message.
probe
if [ "$?" -eq "$BUSY" ]; then
  echo "[ci-gate] waiting for another CI gate on this machine (up to ${TIMEOUT}s)…" >&2
  h=$(holder)
  [ -n "$h" ] && echo "[ci-gate] held by: $h" >&2
fi

start=$(date +%s)
run_locked "$@"
rc=$?
if [ "$rc" -eq "$BUSY" ] && [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then
  echo "[ci-gate] gave up after ${TIMEOUT}s waiting for the CI gate lock ($LOCK)." >&2
  h=$(holder)
  [ -n "$h" ] && echo "[ci-gate] still held by: $h" >&2
  echo "[ci-gate] If that holder is stuck, stop it; the lock frees as soon as it exits." >&2
fi
exit "$rc"

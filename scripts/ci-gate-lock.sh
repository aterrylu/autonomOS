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
# - A waiter gives up after AUTONOMOS_CI_GATE_LOCK_TIMEOUT seconds (default 30
#   min) with a message naming the holder, rather than hanging a push forever.
# - The holder is bounded too (AUTONOMOS_CI_GATE_RUN_TIMEOUT, default 25 min,
#   scripts/run-bounded.sh): past it, its whole process group is stopped, the
#   still-running test files are named, and it exits 124.
# - The path is a FIXED machine-wide file, deliberately not $TMPDIR: agent
#   sessions each get their own sandboxed TMPDIR, so a TMPDIR lock would never
#   be shared between them.
# - With neither tool available it runs the command unlocked, with a warning.
#   The lock is a courtesy to the box, never a reason a push can't happen.
# - Re-entrant: the command runs with AUTONOMOS_GATE_LOCK_HELD=<this lock's
#   path>, and a nested call for the SAME lock runs straight through instead of
#   waiting on itself (the gate holds the lock and runs `make check`, which
#   routes through this script too). A different lock path still queues.
# - Used for every heavy local run, not just the push gate: `make check` (incl.
#   AUTONOMOS_INTEGRATION=1) and `make load-test` take the same one slot.

set -uo pipefail

LOCK="${AUTONOMOS_CI_GATE_LOCK_PATH:-/tmp/autonomos-ci-gate.lock}"
# How long a holder may run before its whole process group is stopped (default
# 25 min, the CI job's own budget). A hung test runner once held the slot for
# 48 min and froze every agent's push behind it.
RUN_TIMEOUT="${AUTONOMOS_CI_GATE_RUN_TIMEOUT:-1500}"
# How long a waiter waits: longer than RUN_TIMEOUT, so a waiter outlives even
# a hung holder that gets stopped at its bound.
TIMEOUT="${AUTONOMOS_CI_GATE_LOCK_TIMEOUT:-1800}"
BOUNDED="$(cd "$(dirname "$0")" && pwd)/run-bounded.sh"
BUSY=75 # EX_TEMPFAIL: lockf's "lock unavailable" code, flock is told to match

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 64
fi


if command -v flock >/dev/null 2>&1; then
  probe() { flock -n -E "$BUSY" "$LOCK" true; }
  run_locked() { flock -w "$TIMEOUT" -E "$BUSY" "$LOCK" env AUTONOMOS_GATE_LOCK_HELD="$LOCK" "$BOUNDED" "$RUN_TIMEOUT" "$@"; }
elif command -v lockf >/dev/null 2>&1; then
  probe() { lockf -k -t 0 "$LOCK" true; }
  run_locked() { lockf -k -t "$TIMEOUT" "$LOCK" env AUTONOMOS_GATE_LOCK_HELD="$LOCK" "$BOUNDED" "$RUN_TIMEOUT" "$@"; }
else
  echo "[ci-gate] neither flock nor lockf found; running WITHOUT the machine-wide lock" >&2
  # Marker, so a fleet harness can refuse to run unlocked (fleet-guard.ts).
  exec env AUTONOMOS_GATE_LOCK_HELD=unlocked "$BOUNDED" "$RUN_TIMEOUT" "$@"
fi

holder() {
  local pids
  pids=$(lsof -t "$LOCK" 2>/dev/null | paste -sd, -)
  [ -n "$pids" ] && ps -o pid=,command= -p "$pids" 2>/dev/null | head -3
}

# The probe runs `true` under the REAL tool, so it reports exactly what the
# gate's own acquire will see: 0 = free, BUSY = held by another gate, anything
# else = the lock file itself can't be opened or created (another user's file
# under Linux fs.protected_regular, an unwritable /tmp in a sandbox). The tool
# would then exit WITHOUT running the gate and fail the push unexplained, so
# we run unlocked instead. If the lock is taken between the probe and the real
# acquire, we just wait without the message.
probe
prc=$?

# Already inside this lock's holder: run, don't wait on ourselves. Only when
# the process holding the lock is one of OUR ancestors: a marker inherited from
# a holder that has exited, or the lock merely being held by someone else (a
# probe, another agent's gate), must not let a run skip the lock.
held_by_ancestor() {
  local holders p h
  command -v lsof >/dev/null 2>&1 || return 2 # can't tell
  holders=$(lsof -t "$LOCK" 2>/dev/null) || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    for h in $holders; do [ "$h" = "$p" ] && return 0; done
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}
if [ "${AUTONOMOS_GATE_LOCK_HELD:-}" = "$LOCK" ] && [ "$prc" -eq "$BUSY" ]; then
  held_by_ancestor
  case $? in
    0) exec "$@" ;;
    # No lsof: trust the marker (waiting on our own holder would deadlock).
    2) exec "$@" ;;
  esac
fi

if [ "$prc" -ne 0 ] && [ "$prc" -ne "$BUSY" ]; then
  echo "[ci-gate] cannot use the lock file $LOCK (exit $prc); running WITHOUT the machine-wide lock" >&2
  exec env AUTONOMOS_GATE_LOCK_HELD=unlocked "$BOUNDED" "$RUN_TIMEOUT" "$@"
fi
if [ "$prc" -eq "$BUSY" ]; then
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
